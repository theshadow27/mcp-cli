import type { Plan, PlanCapability, ServerStatus } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import type { Key } from "ink";
import { extractToolText } from "./ipc-tool-helpers.js";

export interface ExpandedPlanKey {
  id: string;
  server: string;
}

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
  /** Callback to force-refresh plan data. */
  refresh: () => void;
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

/** Get the currently selected plan (or expanded plan). */
function getTargetPlan(nav: PlansNav): Plan | undefined {
  if (nav.expandedPlan) return findExpanded(nav.plans, nav.expandedPlan);
  return nav.plans[nav.selectedIndex];
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
      if (plan && hasCapability(servers, plan.server, "abort")) {
        nav.setStatusMessage("Aborting...");
        callFn("callTool", {
          server: plan.server,
          tool: "abort_plan",
          arguments: { planId: plan.id },
        })
          .then((result) => {
            const text = extractToolText(result);
            if (text) {
              try {
                const parsed = JSON.parse(text);
                if (parsed.error) {
                  nav.setStatusMessage(`Abort failed: ${parsed.error}`);
                  return;
                }
              } catch {
                // not JSON error — treat as success
              }
            }
            nav.setStatusMessage("Plan aborted");
            nav.refresh();
          })
          .catch((err: unknown) => {
            nav.setStatusMessage(`Abort failed: ${err instanceof Error ? err.message : String(err)}`);
          });
      }
      nav.setConfirmAbort(false);
      return true;
    }
    // Any other key cancels the confirmation
    nav.setConfirmAbort(false);
    nav.setStatusMessage(null);
    return true;
  }

  if (plans.length === 0) return false;

  // `a` — Advance plan
  if (input === "a") {
    const plan = getTargetPlan(nav);
    if (!plan) return true;
    if (!hasCapability(servers, plan.server, "advance")) {
      nav.setStatusMessage("Read-only: server does not support advance_plan");
      return true;
    }
    nav.setStatusMessage("Advancing...");
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
        if (text) {
          try {
            const parsed = JSON.parse(text);
            if (parsed.error) {
              // Gate error — show which gates are blocking
              if (parsed.blockedGates && Array.isArray(parsed.blockedGates)) {
                const gateNames = parsed.blockedGates.map((g: { name: string }) => g.name).join(", ");
                nav.setStatusMessage(`Gates blocking: ${gateNames}`);
              } else {
                nav.setStatusMessage(`Advance failed: ${parsed.error}`);
              }
              return;
            }
          } catch {
            // not JSON error — treat as success
          }
        }
        nav.setStatusMessage("Plan advanced");
        nav.refresh();
      })
      .catch((err: unknown) => {
        nav.setStatusMessage(`Advance failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    return true;
  }

  // `x` — Abort plan (enter confirmation mode)
  if (input === "x") {
    const plan = getTargetPlan(nav);
    if (!plan) return true;
    if (!hasCapability(servers, plan.server, "abort")) {
      nav.setStatusMessage("Read-only: server does not support abort_plan");
      return true;
    }
    nav.setStatusMessage(`Abort plan "${plan.name}"? (y/n)`);
    nav.setConfirmAbort(true);
    return true;
  }

  // `r` — Force refresh
  if (input === "r") {
    nav.setStatusMessage("Refreshing...");
    nav.refresh();
    // Clear message after a short delay (the refresh callback will update data)
    setTimeout(() => nav.setStatusMessage(null), 1000);
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

  // ↑/↓ or j/k navigate plan list
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
