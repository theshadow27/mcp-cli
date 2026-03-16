import type { Plan, PlanMetrics, ServerStatus } from "@mcp-cli/core";
import {
  CLAUDE_SERVER_NAME,
  GetPlanMetricsResultSchema,
  GetPlanResultSchema,
  ListPlansResultSchema,
} from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { useEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "../components/claude-plan-adapter.js";
import { extractPlansFromTranscript } from "../components/claude-plan-adapter.js";
import { extractToolText } from "./ipc-tool-helpers.js";

// -- Claude plan helpers --

/** Max transcript entries to scan for plan data per session. */
const CLAUDE_TRANSCRIPT_LIMIT = 100;

/**
 * Fetch plans from active Claude Code sessions by scanning transcripts
 * for TodoWrite tool calls or plan-like markdown.
 */
async function fetchClaudePlans(ipcCallFn: typeof ipcCall, cancelled: boolean): Promise<Plan[]> {
  try {
    // Get session list from _claude virtual server
    const listResult = await ipcCallFn("callTool", {
      server: CLAUDE_SERVER_NAME,
      tool: "claude_session_list",
      arguments: {},
    });
    if (cancelled) return [];

    const listText = extractToolText(listResult);
    if (!listText) return [];

    const sessions = JSON.parse(listText) as Array<{ sessionId: string; state: string }>;
    // Only scan active/idle sessions (skip ended/disconnected)
    const liveSessions = sessions.filter((s) => s.state !== "ended" && s.state !== "disconnected");
    if (liveSessions.length === 0) return [];

    const plans: Plan[] = [];

    await Promise.allSettled(
      liveSessions.map(async (session) => {
        try {
          const transcriptResult = await ipcCallFn("callTool", {
            server: CLAUDE_SERVER_NAME,
            tool: "claude_transcript",
            arguments: { sessionId: session.sessionId, limit: CLAUDE_TRANSCRIPT_LIMIT },
          });
          if (cancelled) return;

          const transcriptText = extractToolText(transcriptResult);
          if (!transcriptText) return;

          const entries = JSON.parse(transcriptText) as TranscriptEntry[];
          const plan = extractPlansFromTranscript(entries, session.sessionId);
          if (plan) {
            plans.push(plan);
          }
        } catch {
          // One session failing doesn't break the whole list
        }
      }),
    );

    return plans;
  } catch {
    // _claude server not available — not an error, just no Claude plans
    return [];
  }
}

// -- usePlans --

export interface UsePlansResult {
  plans: Plan[];
  loading: boolean;
  error: string | null;
  /** True when the last poll failed (stale data is shown). */
  disconnected: boolean;
}

export interface UsePlansOptions {
  intervalMs?: number;
  enabled?: boolean;
  /** Override ipcCall for testing (dependency injection). */
  ipcCallFn?: typeof ipcCall;
}

/**
 * Polls `list_plans` on all plan-capable servers every 30s.
 * Aggregates results across all servers into a single flat list.
 */
export function usePlans(opts: UsePlansOptions = {}): UsePlansResult {
  const { intervalMs = 30_000, enabled = true, ipcCallFn = ipcCall } = opts;
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function poll() {
      try {
        const status = await ipcCallFn("status");
        if (cancelled) return;

        const planServers = status.servers.filter(
          (s: ServerStatus) => s.state === "connected" && s.planCapabilities?.capabilities.includes("list"),
        );

        const allPlans: Plan[] = [];
        let successCount = 0;

        await Promise.allSettled(
          planServers.map(async (srv: ServerStatus) => {
            try {
              const result = await ipcCallFn("callTool", {
                server: srv.name,
                tool: "list_plans",
                arguments: {},
              });
              const text = extractToolText(result);
              if (!text) return;
              const parsed = ListPlansResultSchema.safeParse(JSON.parse(text));
              if (parsed.success) {
                successCount++;
                allPlans.push(...parsed.data.plans);
              }
            } catch {
              // One server failing doesn't break the whole list
            }
          }),
        );

        if (cancelled) return;

        // Also fetch Claude session plans (read-only)
        const claudePlans = await fetchClaudePlans(ipcCallFn, cancelled);
        if (cancelled) return;
        allPlans.push(...claudePlans);

        const allFailed = planServers.length > 0 && successCount === 0;
        setPlans(allPlans);
        setError(null);
        setDisconnected(allFailed);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setDisconnected(true);
        setLoading(false);
      }
    }

    let timerId: ReturnType<typeof setTimeout> | undefined;

    async function scheduleNext() {
      await poll();
      if (!cancelled) {
        timerId = setTimeout(scheduleNext, intervalMs);
      }
    }

    scheduleNext();

    return () => {
      cancelled = true;
      if (timerId !== undefined) clearTimeout(timerId);
    };
  }, [intervalMs, enabled, ipcCallFn]);

  return { plans, loading, error, disconnected };
}

// -- usePlan --

export interface UsePlanResult {
  plan: Plan | null;
  loading: boolean;
  error: string | null;
  /** True when the server has `advance_plan` capability. */
  canAdvance: boolean;
  /** True when the last fetch failed (stale data is shown). */
  disconnected: boolean;
}

export interface UsePlanOptions {
  enabled?: boolean;
  /**
   * Whether the plan server supports `advance_plan`.
   * Pass from server's `planCapabilities` (e.g. from `usePlans` or `useDaemon`).
   * Defaults to false if not provided.
   */
  canAdvance?: boolean;
  /** Override ipcCall for testing (dependency injection). */
  ipcCallFn?: typeof ipcCall;
}

/**
 * Fetches a single plan via `get_plan`. Re-fetches when planId or server changes.
 */
export function usePlan(planId: string, server: string, opts: UsePlanOptions = {}): UsePlanResult {
  const { enabled = true, canAdvance = false, ipcCallFn = ipcCall } = opts;
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);

  useEffect(() => {
    if (!enabled || !planId || !server) return;

    let cancelled = false;

    async function fetch() {
      try {
        const result = await ipcCallFn("callTool", {
          server,
          tool: "get_plan",
          arguments: { planId },
        });
        if (cancelled) return;
        const text = extractToolText(result);
        if (text) {
          const parsed = GetPlanResultSchema.safeParse(JSON.parse(text));
          if (parsed.success) {
            setPlan(parsed.data.plan);
          }
        }
        setError(null);
        setDisconnected(false);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setDisconnected(true);
        setLoading(false);
      }
    }

    fetch();

    return () => {
      cancelled = true;
    };
  }, [planId, server, enabled, ipcCallFn]);

  return { plan, loading, error, canAdvance, disconnected };
}

// -- usePlanMetrics --

export interface UsePlanMetricsResult {
  metrics: PlanMetrics | null;
  loading: boolean;
  error: string | null;
}

export interface UsePlanMetricsOptions {
  intervalMs?: number;
  enabled?: boolean;
  /**
   * Whether the plan server supports `get_plan_metrics`.
   * When false, the hook returns null immediately without polling.
   * Pass from server's `planCapabilities.capabilities.includes("metrics")`.
   */
  supportsMetrics?: boolean;
  /** Override ipcCall for testing (dependency injection). */
  ipcCallFn?: typeof ipcCall;
}

/**
 * Polls `get_plan_metrics` every 5s for the given plan/step.
 * Returns `{ metrics: null }` when the server doesn't support metrics.
 */
export function usePlanMetrics(
  planId: string,
  stepId: string | undefined,
  server: string,
  opts: UsePlanMetricsOptions = {},
): UsePlanMetricsResult {
  const { intervalMs = 5_000, enabled = true, supportsMetrics = false, ipcCallFn = ipcCall } = opts;
  const [metrics, setMetrics] = useState<PlanMetrics | null>(null);
  const [loading, setLoading] = useState(supportsMetrics);
  const [error, setError] = useState<string | null>(null);

  // Track supportsMetrics in a ref so the effect can read the latest value
  const supportsRef = useRef(supportsMetrics);
  supportsRef.current = supportsMetrics;

  useEffect(() => {
    if (!enabled || !supportsMetrics || !planId || !server) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function poll() {
      try {
        const result = await ipcCallFn("callTool", {
          server,
          tool: "get_plan_metrics",
          arguments: stepId ? { planId, stepId } : { planId },
        });
        if (cancelled) return;
        const text = extractToolText(result);
        if (text) {
          const parsed = GetPlanMetricsResultSchema.safeParse(JSON.parse(text));
          if (parsed.success) {
            setMetrics(parsed.data.metrics);
          }
        }
        setError(null);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }

    let timerId: ReturnType<typeof setTimeout> | undefined;

    async function scheduleNext() {
      await poll();
      if (!cancelled) {
        timerId = setTimeout(scheduleNext, intervalMs);
      }
    }

    scheduleNext();

    return () => {
      cancelled = true;
      if (timerId !== undefined) clearTimeout(timerId);
    };
  }, [planId, stepId, server, intervalMs, enabled, supportsMetrics, ipcCallFn]);

  return { metrics, loading, error };
}
