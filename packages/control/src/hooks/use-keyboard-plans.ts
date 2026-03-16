import type { Plan, PlanCapability, ServerStatus } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import type { Key } from "ink";
import { extractToolText } from "./ipc-tool-helpers";

export interface ExpandedPlanKey {
  id: string;
  server: string;
}

export type StatusType = "error" | "success" | "warning" | "info";

export interface PlansNav {
  plans: Plan[];
  selectedIndex: number;
  setSelectedIndex: (fn: (i: number) => number) => void;
  expandedPlan: ExpandedPlanKey | null;
  setExpandedPlan: (key: ExpandedPlanKey | null) => void;
  selectedStep: number;
  setSelectedStep: (fn: (i: number) => number) => void;
  /** Server status list — used to check plan capabilities. */
  servers: ServerStatus[];
  /** Confirmation mode for abort. */
  confirmAbort: boolean;
  setConfirmAbort: (v: boolean) => void;
  /** Inline status/error message shown after actions. */
  statusMessage: string | null;
  setStatusMessage: (msg: string | null) => void;
  /** Semantic type for status message coloring. */
  statusType: StatusType | null;
  setStatusType: (type: StatusType | null) => void;
  /** Whether an IPC action (advance/abort) is in flight. */
  inflight: boolean;
  setInflight: (v: boolean) => void;
  /** Callback to force-refresh plan data. Accepts optional completion callback. */
  refresh: (onComplete?: () => void) => void;
  /** Whether a refresh is currently in progress (debounce guard). */
  refreshing: boolean;
  setRefreshing: (v: boolean) => void;
  /** Override ipcCall for testing (dependency injection). */
  ipcCallFn?: typeof ipcCall;
}

/** Match a plan by composite key (id + server). */
function findExpanded(plans: Plan[], key: ExpandedPlanKey | null): Plan | undefined {
  if (!key) return undefined;
  return plans.find((p) => p.id === key.id && p.server === key.server);
}

/** Check whether a server has a specific plan capability. */
export function hasCapability(servers: ServerStatus[], serverName: string, cap: PlanCapability): boolean {
  const srv = servers.find((s) => s.name === serverName);
  return srv?.planCapabilities?.capabilities.includes(cap) ?? false;
}

/** Check whether a plan's server is read-only (lacks both advance and abort). */
export function isPlanReadOnly(servers: ServerStatus[], plan: Plan): boolean {
  return !hasCapability(servers, plan.server, "advance") && !hasCapability(servers, plan.server, "abort");
}

/** Get the currently selected plan (or expanded plan). */
function getTargetPlan(nav: PlansNav): Plan | undefined {
  if (nav.expandedPlan) return findExpanded(nav.plans, nav.expandedPlan);
  return nav.plans[nav.selectedIndex];
}

/** Set both status message and type atomically. */
function setStatus(nav: PlansNav, message: string | null, type: StatusType | null = null): void {
  nav.setStatusMessage(message);
  nav.setStatusType(type);
}

/** Clear all plans-specific modal state (confirmAbort, status, inflight). */
export function clearPlansState(nav: PlansNav): void {
  nav.setConfirmAbort(false);
  nav.setInflight(false);
  nav.setRefreshing(false);
  setStatus(nav, null, null);
}

/** Type-narrow a tool response text for error detection. */
interface ToolErrorResponse {
  error: string;
  blockedGates?: Array<{ name: string }>;
}

function parseToolError(text: string | null): ToolErrorResponse | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const obj = parsed as Record<string, unknown>;
      const error = typeof obj.error === "string" ? obj.error : String(obj.error);
      const blockedGates = Array.isArray(obj.blockedGates) ? (obj.blockedGates as Array<{ name: string }>) : undefined;
      return { error, blockedGates };
    }
  } catch {
    // not JSON
  }
  return null;
}

/**
 * Handle keyboard input for the plans view.
 * Returns true if the input was consumed.
 */
export function handlePlansInput(input: string, key: Key, nav: PlansNav): boolean {
  const { plans, selectedIndex, expandedPlan, servers } = nav;
  const callFn = nav.ipcCallFn ?? ipcCall;

  // Abort confirmation mode — capture y/n, ignore everything else
  if (nav.confirmAbort) {
    if (input === "y" || input === "Y") {
      const plan = getTargetPlan(nav);
      if (!plan || !hasCapability(servers, plan.server, "abort")) {
        // Plan disappeared or lost capability while confirming
        nav.setConfirmAbort(false);
        setStatus(nav, plan ? "Abort failed: capability lost" : "Abort failed: plan no longer exists", "error");
        return true;
      }
      setStatus(nav, "Aborting...", "info");
      nav.setInflight(true);
      callFn("callTool", {
        server: plan.server,
        tool: "abort_plan",
        arguments: { planId: plan.id },
      })
        .then((result) => {
          const text = extractToolText(result);
          const err = parseToolError(text);
          if (err) {
            setStatus(nav, `Abort failed: ${err.error}`, "error");
            return;
          }
          setStatus(nav, "Plan aborted", "success");
          nav.refresh(() => setStatus(nav, null, null));
        })
        .catch((err: unknown) => {
          setStatus(nav, `Abort failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        })
        .finally(() => {
          nav.setInflight(false);
        });
      nav.setConfirmAbort(false);
      return true;
    }
    // Any other key cancels the confirmation
    nav.setConfirmAbort(false);
    setStatus(nav, null, null);
    return true;
  }

  if (plans.length === 0) return false;

  // `a` — Advance plan
  if (input === "a") {
    if (nav.inflight) return true; // guard against double-fire
    const plan = getTargetPlan(nav);
    if (!plan) return true;
    if (!hasCapability(servers, plan.server, "advance")) {
      setStatus(nav, "Read-only: server does not support advance_plan", "warning");
      return true;
    }
    setStatus(nav, "Advancing...", "info");
    nav.setInflight(true);
    const args: Record<string, string> = { planId: plan.id };
    // If a specific step is selected in expanded view, pass it
    if (expandedPlan) {
      const step = plan.steps[nav.selectedStep];
      if (step) args.stepId = step.id;
    }
    callFn("callTool", {
      server: plan.server,
      tool: "advance_plan",
      arguments: args,
    })
      .then((result) => {
        const text = extractToolText(result);
        const err = parseToolError(text);
        if (err) {
          if (err.blockedGates && err.blockedGates.length > 0) {
            const gateNames = err.blockedGates.map((g) => g.name).join(", ");
            setStatus(nav, `Gates blocking: ${gateNames}`, "error");
          } else {
            setStatus(nav, `Advance failed: ${err.error}`, "error");
          }
          return;
        }
        setStatus(nav, "Plan advanced", "success");
        nav.refresh(() => setStatus(nav, null, null));
      })
      .catch((err: unknown) => {
        setStatus(nav, `Advance failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      })
      .finally(() => {
        nav.setInflight(false);
      });
    return true;
  }

  // `x` — Abort plan (enter confirmation mode)
  if (input === "x") {
    if (nav.inflight) return true; // guard against starting abort while action in flight
    const plan = getTargetPlan(nav);
    if (!plan) return true;
    if (!hasCapability(servers, plan.server, "abort")) {
      setStatus(nav, "Read-only: server does not support abort_plan", "warning");
      return true;
    }
    setStatus(nav, `Abort plan "${plan.name}"? (y/n)`, "warning");
    nav.setConfirmAbort(true);
    return true;
  }

  // `r` — Force refresh (debounced: ignore if already refreshing)
  if (input === "r") {
    if (nav.refreshing) return true;
    nav.setRefreshing(true);
    setStatus(nav, "Refreshing...", "info");
    nav.refresh(() => {
      nav.setRefreshing(false);
      setStatus(nav, null, null);
    });
    return true;
  }

  // When a plan is expanded, ←/→ navigate steps
  if (expandedPlan !== null) {
    const plan = findExpanded(plans, expandedPlan);
    if (!plan) return false;

    if (key.leftArrow) {
      nav.setSelectedStep((i) => Math.max(0, i - 1));
      return true;
    }
    if (key.rightArrow) {
      nav.setSelectedStep((i) => Math.min(Math.max(0, plan.steps.length - 1), i + 1));
      return true;
    }
  }

  // up/down or j/k navigate plan list
  if (key.upArrow || input === "k") {
    nav.setSelectedIndex((i) => Math.max(0, i - 1));
    return true;
  }
  if (key.downArrow || input === "j") {
    nav.setSelectedIndex((i) => Math.min(plans.length - 1, i + 1));
    return true;
  }

  // Enter: toggle expand/collapse
  if (key.return) {
    const plan = plans[selectedIndex];
    if (!plan) return false;
    if (expandedPlan && expandedPlan.id === plan.id && expandedPlan.server === plan.server) {
      nav.setExpandedPlan(null);
      nav.setSelectedStep(() => 0);
    } else {
      nav.setExpandedPlan({ id: plan.id, server: plan.server });
      // Default selected step to the active step
      const activeIdx = plan.activeStepId ? plan.steps.findIndex((s) => s.id === plan.activeStepId) : 0;
      nav.setSelectedStep(() => Math.max(0, activeIdx));
    }
    return true;
  }

  return false;
}
