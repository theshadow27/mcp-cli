import { describe, expect, it } from "bun:test";
import type { Plan } from "@mcp-cli/core";
import type { Key } from "ink";
import { type ExpandedPlanKey, type PlansNav, handlePlansInput } from "./use-keyboard-plans";

function makePlan(overrides: Partial<Plan> & { id: string }): Plan {
  return {
    name: `Plan ${overrides.id}`,
    status: "active",
    server: "test-server",
    steps: [
      { id: "s1", name: "Step 1", status: "complete" },
      { id: "s2", name: "Step 2", status: "active" },
      { id: "s3", name: "Step 3", status: "pending" },
    ],
    activeStepId: "s2",
    ...overrides,
  };
}

const baseKey: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

function makeNav(overrides: Partial<PlansNav> = {}): PlansNav & { state: Record<string, unknown> } {
  const state: Record<string, unknown> = {
    selectedIndex: overrides.selectedIndex ?? 0,
    expandedPlan: overrides.expandedPlan ?? null,
    selectedStep: overrides.selectedStep ?? 0,
  };

  return {
    plans: overrides.plans ?? [makePlan({ id: "p1" }), makePlan({ id: "p2" }), makePlan({ id: "p3" })],
    selectedIndex: state.selectedIndex as number,
    setSelectedIndex: (fn) => {
      state.selectedIndex = fn(state.selectedIndex as number);
    },
    expandedPlan: state.expandedPlan as ExpandedPlanKey | null,
    setExpandedPlan: (key) => {
      state.expandedPlan = key;
    },
    selectedStep: state.selectedStep as number,
    setSelectedStep: (fn) => {
      state.selectedStep = fn(state.selectedStep as number);
    },
    state,
    ...overrides,
  };
}

describe("handlePlansInput", () => {
  it("navigates down with j", () => {
    const nav = makeNav();
    const consumed = handlePlansInput("j", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.state.selectedIndex).toBe(1);
  });

  it("navigates down with down arrow", () => {
    const nav = makeNav();
    handlePlansInput("", { ...baseKey, downArrow: true }, nav);
    expect(nav.state.selectedIndex).toBe(1);
  });

  it("navigates up with k", () => {
    const nav = makeNav({ selectedIndex: 2 });
    handlePlansInput("k", baseKey, nav);
    expect(nav.state.selectedIndex).toBe(1);
  });

  it("navigates up with up arrow", () => {
    const nav = makeNav({ selectedIndex: 2 });
    handlePlansInput("", { ...baseKey, upArrow: true }, nav);
    expect(nav.state.selectedIndex).toBe(1);
  });

  it("clamps at top boundary", () => {
    const nav = makeNav();
    handlePlansInput("", { ...baseKey, upArrow: true }, nav);
    expect(nav.state.selectedIndex).toBe(0);
  });

  it("clamps at bottom boundary", () => {
    const nav = makeNav({ selectedIndex: 2 });
    handlePlansInput("", { ...baseKey, downArrow: true }, nav);
    expect(nav.state.selectedIndex).toBe(2);
  });

  it("expands plan on enter with composite key", () => {
    const nav = makeNav();
    handlePlansInput("", { ...baseKey, return: true }, nav);
    expect(nav.state.expandedPlan).toEqual({ id: "p1", server: "test-server" });
  });

  it("sets selected step to active step on expand", () => {
    const nav = makeNav();
    handlePlansInput("", { ...baseKey, return: true }, nav);
    // activeStepId is "s2" which is index 1
    expect(nav.state.selectedStep).toBe(1);
  });

  it("collapses plan on enter when already expanded", () => {
    const nav = makeNav({ expandedPlan: { id: "p1", server: "test-server" } });
    handlePlansInput("", { ...baseKey, return: true }, nav);
    expect(nav.state.expandedPlan).toBeNull();
    expect(nav.state.selectedStep).toBe(0);
  });

  it("navigates steps left when expanded", () => {
    const nav = makeNav({ expandedPlan: { id: "p1", server: "test-server" }, selectedStep: 2 });
    handlePlansInput("", { ...baseKey, leftArrow: true }, nav);
    expect(nav.state.selectedStep).toBe(1);
  });

  it("navigates steps right when expanded", () => {
    const nav = makeNav({ expandedPlan: { id: "p1", server: "test-server" }, selectedStep: 0 });
    handlePlansInput("", { ...baseKey, rightArrow: true }, nav);
    expect(nav.state.selectedStep).toBe(1);
  });

  it("clamps step at left boundary", () => {
    const nav = makeNav({ expandedPlan: { id: "p1", server: "test-server" }, selectedStep: 0 });
    handlePlansInput("", { ...baseKey, leftArrow: true }, nav);
    expect(nav.state.selectedStep).toBe(0);
  });

  it("clamps step at right boundary", () => {
    const nav = makeNav({ expandedPlan: { id: "p1", server: "test-server" }, selectedStep: 2 });
    handlePlansInput("", { ...baseKey, rightArrow: true }, nav);
    expect(nav.state.selectedStep).toBe(2);
  });

  it("returns false on empty plans", () => {
    const nav = makeNav({ plans: [] });
    const consumed = handlePlansInput("j", baseKey, nav);
    expect(consumed).toBe(false);
  });

  it("returns false for unrecognized input", () => {
    const nav = makeNav();
    const consumed = handlePlansInput("x", baseKey, nav);
    expect(consumed).toBe(false);
  });

  it("defaults selectedStep to 0 when no activeStepId", () => {
    const plans = [makePlan({ id: "p1", activeStepId: undefined })];
    const nav = makeNav({ plans });
    handlePlansInput("", { ...baseKey, return: true }, nav);
    expect(nav.state.selectedStep).toBe(0);
  });

  it("distinguishes plans with same id on different servers", () => {
    const plans = [makePlan({ id: "deploy", server: "server-a" }), makePlan({ id: "deploy", server: "server-b" })];
    const nav = makeNav({ plans, selectedIndex: 1 });
    handlePlansInput("", { ...baseKey, return: true }, nav);
    expect(nav.state.expandedPlan).toEqual({ id: "deploy", server: "server-b" });
  });

  it("does not collapse plan from different server with same id", () => {
    const plans = [makePlan({ id: "deploy", server: "server-a" }), makePlan({ id: "deploy", server: "server-b" })];
    // Expanded plan is server-a's "deploy", selected index is 1 (server-b's "deploy")
    const nav = makeNav({
      plans,
      selectedIndex: 1,
      expandedPlan: { id: "deploy", server: "server-a" },
    });
    handlePlansInput("", { ...baseKey, return: true }, nav);
    // Should expand server-b's deploy, not collapse server-a's
    expect(nav.state.expandedPlan).toEqual({ id: "deploy", server: "server-b" });
  });
});
