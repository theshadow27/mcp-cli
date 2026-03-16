import type { Plan } from "@mcp-cli/core";
import type { Key } from "ink";

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
}

/** Match a plan by composite key (id + server). */
function findExpanded(plans: Plan[], key: ExpandedPlanKey | null): Plan | undefined {
  if (!key) return undefined;
  return plans.find((p) => p.id === key.id && p.server === key.server);
}

/**
 * Handle keyboard input for the plans view.
 * Returns true if the input was consumed.
 */
export function handlePlansInput(input: string, key: Key, nav: PlansNav): boolean {
  const { plans, selectedIndex, expandedPlan } = nav;

  if (plans.length === 0) return false;

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
