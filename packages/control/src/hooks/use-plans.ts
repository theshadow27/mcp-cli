import type { Plan, PlanMetrics, ServerStatus } from "@mcp-cli/core";
import {
  CLAUDE_SERVER_NAME,
  GetPlanMetricsResultSchema,
  GetPlanResultSchema,
  ListPlansResultSchema,
} from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "../lib/claude-plan-adapter.js";
import { extractPlansFromTranscript } from "../lib/claude-plan-adapter.js";
import { extractToolText } from "./ipc-tool-helpers.js";

/** Per-server IPC timeout to prevent a single hanging server from stalling the poll loop. */
const IPC_TIMEOUT_MS = 8_000;

/** Races a promise against a timeout. Rejects with a descriptive error on expiry. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label}: timeout after ${ms}ms`)), ms)),
  ]);
}

// -- Claude plan helpers --

/**
 * Max transcript entries to scan for plan data per session.
 * Must be large enough to capture TodoWrite calls from early in a session —
 * the daemon returns the tail (most recent N), so a low limit silently
 * misses old TodoWrites and falls back to the markdown heuristic.
 */
const CLAUDE_TRANSCRIPT_LIMIT = 500;

/** Session states worth scanning for plan data. */
const LIVE_STATES = new Set(["active", "waiting_permission", "result", "idle"]);

/**
 * Fetch plans from active Claude Code sessions by scanning transcripts
 * for TodoWrite tool calls or plan-like markdown.
 */
async function fetchClaudePlans(
  ipcCallFn: typeof ipcCall,
  cancelRef: { current: boolean },
  timeoutMs = IPC_TIMEOUT_MS,
): Promise<Plan[]> {
  try {
    // Get session list from _claude virtual server
    const listResult = await withTimeout(
      ipcCallFn("callTool", {
        server: CLAUDE_SERVER_NAME,
        tool: "claude_session_list",
        arguments: {},
      }),
      timeoutMs,
      "claude_session_list",
    );
    if (cancelRef.current) return [];

    const listText = extractToolText(listResult);
    if (!listText) return [];

    const sessions = JSON.parse(listText) as Array<{ sessionId: string; state: string }>;
    const liveSessions = sessions.filter((s) => LIVE_STATES.has(s.state));
    if (liveSessions.length === 0) return [];

    const plans: Plan[] = [];

    await Promise.allSettled(
      liveSessions.map(async (session) => {
        try {
          const transcriptResult = await withTimeout(
            ipcCallFn("callTool", {
              server: CLAUDE_SERVER_NAME,
              tool: "claude_transcript",
              arguments: { sessionId: session.sessionId, limit: CLAUDE_TRANSCRIPT_LIMIT },
            }),
            timeoutMs,
            `claude_transcript(${session.sessionId})`,
          );
          if (cancelRef.current) return;

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

    // Sort by sessionId for deterministic ordering across polls
    plans.sort((a, b) => a.id.localeCompare(b.id));
    return plans;
  } catch (err) {
    // _claude server not available is expected — only log unexpected errors
    if (!(err instanceof Error && err.message.includes("not found"))) {
      console.error("[use-plans] fetchClaudePlans failed:", err);
    }
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
  /** Force an immediate re-poll. Accepts optional completion callback. */
  refresh: (onComplete?: () => void) => void;
}

export interface UsePlansOptions {
  intervalMs?: number;
  enabled?: boolean;
  /** Per-server IPC timeout in ms (default 8000). Override for testing. */
  timeoutMs?: number;
  /** Override ipcCall for testing (dependency injection). */
  ipcCallFn?: typeof ipcCall;
}

/**
 * Polls `list_plans` on all plan-capable servers every 30s.
 * Aggregates results across all servers into a single flat list.
 */
export function usePlans(opts: UsePlansOptions = {}): UsePlansResult {
  const { intervalMs = 30_000, enabled = true, timeoutMs = IPC_TIMEOUT_MS, ipcCallFn = ipcCall } = opts;
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [tick, setTick] = useState(0);
  const refreshCallbackRef = useRef<(() => void) | null>(null);

  // Store ipcCallFn in a ref so callers don't need to memoize it
  const ipcCallRef = useRef(ipcCallFn);
  ipcCallRef.current = ipcCallFn;

  const refresh = useCallback((onComplete?: () => void) => {
    refreshCallbackRef.current = onComplete ?? null;
    setTick((t) => t + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick triggers re-poll on refresh()
  useEffect(() => {
    if (!enabled) return;

    // Reset loading state so stale data isn't shown without a spinner
    // when the tab is re-enabled after being hidden (#775)
    setLoading(true);

    const cancelRef = { current: false };

    async function poll() {
      try {
        const status = await ipcCallRef.current("status");
        if (cancelRef.current) return;

        const planServers = status.servers.filter(
          (s: ServerStatus) => s.state === "connected" && s.planCapabilities?.capabilities.includes("list"),
        );

        const allPlans: Plan[] = [];
        let successCount = 0;

        // Fetch server plans and Claude session plans in parallel
        const [_serverResults, claudePlans] = await Promise.all([
          Promise.allSettled(
            planServers.map(async (srv: ServerStatus) => {
              try {
                const result = await withTimeout(
                  ipcCallRef.current("callTool", {
                    server: srv.name,
                    tool: "list_plans",
                    arguments: {},
                  }),
                  timeoutMs,
                  `list_plans(${srv.name})`,
                );
                const text = extractToolText(result);
                if (!text) return;
                const parsed = ListPlansResultSchema.safeParse(JSON.parse(text));
                if (parsed.success) {
                  successCount++;
                  allPlans.push(...parsed.data.plans);
                } else {
                  console.error(`[usePlans] parse error for server ${srv.name}:`, parsed.error.issues);
                }
              } catch {
                // One server failing doesn't break the whole list
              }
            }),
          ),
          fetchClaudePlans(ipcCallRef.current, cancelRef, timeoutMs),
        ]);

        if (cancelRef.current) return;
        allPlans.push(...claudePlans);

        const allFailed = planServers.length > 0 && successCount === 0;
        // Sort deterministically so Promise.allSettled arrival order doesn't shift the list
        allPlans.sort((a, b) => a.server.localeCompare(b.server) || a.id.localeCompare(b.id));
        setPlans(allPlans);
        setError(null);
        setDisconnected(allFailed);
        setLoading(false);
        if (refreshCallbackRef.current) {
          refreshCallbackRef.current();
          refreshCallbackRef.current = null;
        }
      } catch (err) {
        if (cancelRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setDisconnected(true);
        setLoading(false);
        if (refreshCallbackRef.current) {
          refreshCallbackRef.current();
          refreshCallbackRef.current = null;
        }
      }
    }

    let timerId: ReturnType<typeof setTimeout> | undefined;

    async function scheduleNext() {
      await poll();
      if (!cancelRef.current) {
        timerId = setTimeout(scheduleNext, intervalMs);
      }
    }

    scheduleNext();

    return () => {
      cancelRef.current = true;
      if (timerId !== undefined) clearTimeout(timerId);
    };
  }, [intervalMs, enabled, tick]);

  return { plans, loading, error, disconnected, refresh };
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

  const ipcCallRef = useRef(ipcCallFn);
  ipcCallRef.current = ipcCallFn;

  useEffect(() => {
    if (!enabled || !planId || !server) return;

    // Reset loading when re-enabled so stale data shows a spinner (#775)
    setLoading(true);

    let cancelled = false;

    async function fetch() {
      try {
        const result = await ipcCallRef.current("callTool", {
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
          } else {
            console.error(`[usePlan] parse error for plan ${planId} on ${server}:`, parsed.error.issues);
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
  }, [planId, server, enabled]);

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
  /** Per-server IPC timeout in ms (default 8000). Override for testing. */
  timeoutMs?: number;
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
  const {
    intervalMs = 5_000,
    enabled = true,
    timeoutMs = IPC_TIMEOUT_MS,
    supportsMetrics = false,
    ipcCallFn = ipcCall,
  } = opts;
  const [metrics, setMetrics] = useState<PlanMetrics | null>(null);
  const [loading, setLoading] = useState(supportsMetrics);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !supportsMetrics || !planId || !server) {
      setMetrics(null);
      setLoading(false);
      return;
    }

    // Clear stale metrics from the previous plan/step before polling the new one
    setMetrics(null);
    setLoading(true);

    let cancelled = false;

    async function poll() {
      try {
        const result = await withTimeout(
          ipcCallFn("callTool", {
            server,
            tool: "get_plan_metrics",
            arguments: stepId ? { planId, stepId } : { planId },
          }),
          timeoutMs,
          `get_plan_metrics(${server})`,
        );
        if (cancelled) return;
        const text = extractToolText(result);
        if (text) {
          const parsed = GetPlanMetricsResultSchema.safeParse(JSON.parse(text));
          if (parsed.success) {
            setMetrics(parsed.data.metrics);
          } else {
            console.error(`[usePlanMetrics] parse error for plan ${planId} on ${server}:`, parsed.error.issues);
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
  }, [planId, stepId, server, intervalMs, timeoutMs, enabled, supportsMetrics, ipcCallFn]);

  return { metrics, loading, error };
}
