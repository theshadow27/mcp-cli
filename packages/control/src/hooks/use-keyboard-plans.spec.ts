import { describe, expect, it } from "bun:test";
import type { Plan, ServerStatus } from "@mcp-cli/core";
import type { Key } from "ink";
import {
  type ExpandedPlanKey,
  type PlansNav,
  type StatusType,
  clearPlansState,
  handlePlansInput,
  hasCapability,
  isPlanReadOnly,
} from "./use-keyboard-plans";

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

function makeServer(name: string, capabilities: string[] = []): ServerStatus {
  return {
    name,
    state: "connected",
    source: "config",
    planCapabilities: capabilities.length > 0 ? { capabilities } : undefined,
  } as ServerStatus;
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
    confirmAbort: overrides.confirmAbort ?? false,
    statusMessage: overrides.statusMessage ?? null,
    statusType: overrides.statusType ?? null,
    inflight: overrides.inflight ?? false,
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
    servers: overrides.servers ?? [makeServer("test-server", ["list", "get", "advance", "abort"])],
    confirmAbort: state.confirmAbort as boolean,
    setConfirmAbort: (v) => {
      state.confirmAbort = v;
    },
    statusMessage: state.statusMessage as string | null,
    setStatusMessage: (msg) => {
      state.statusMessage = msg;
    },
    statusType: state.statusType as StatusType | null,
    setStatusType: (type) => {
      state.statusType = type;
    },
    inflight: state.inflight as boolean,
    setInflight: (v) => {
      state.inflight = v;
    },
    refresh: overrides.refresh ?? (() => {}),
    ipcCallFn: overrides.ipcCallFn,
    state,
    ...overrides,
  };
}

/** Poll for a condition with a deadline instead of fixed delay. */
async function pollUntil(fn: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await Bun.sleep(1);
  }
}

describe("handlePlansInput", () => {
  // -- Navigation (existing tests) --

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

  it("defaults selectedStep to 0 when no activeStepId", () => {
    const plans = [makePlan({ id: "p1", activeStepId: undefined })];
    const nav = makeNav({ plans });
    handlePlansInput("", { ...baseKey, return: true }, nav);
    expect(nav.state.selectedStep).toBe(0);
  });

  it("distinguishes plans with same id on different servers", () => {
    const plans = [makePlan({ id: "deploy", server: "server-a" }), makePlan({ id: "deploy", server: "server-b" })];
    const nav = makeNav({
      plans,
      selectedIndex: 1,
      servers: [
        makeServer("server-a", ["list", "get", "advance", "abort"]),
        makeServer("server-b", ["list", "get", "advance", "abort"]),
      ],
    });
    handlePlansInput("", { ...baseKey, return: true }, nav);
    expect(nav.state.expandedPlan).toEqual({ id: "deploy", server: "server-b" });
  });

  it("does not collapse plan from different server with same id", () => {
    const plans = [makePlan({ id: "deploy", server: "server-a" }), makePlan({ id: "deploy", server: "server-b" })];
    const nav = makeNav({
      plans,
      selectedIndex: 1,
      expandedPlan: { id: "deploy", server: "server-a" },
      servers: [
        makeServer("server-a", ["list", "get", "advance", "abort"]),
        makeServer("server-b", ["list", "get", "advance", "abort"]),
      ],
    });
    handlePlansInput("", { ...baseKey, return: true }, nav);
    expect(nav.state.expandedPlan).toEqual({ id: "deploy", server: "server-b" });
  });

  // -- Advance (a) --

  it("advance calls ipc with plan id", () => {
    let callArgs: unknown = null;
    const mockIpc = ((...args: unknown[]) => {
      callArgs = args;
      return Promise.resolve({ content: [{ type: "text", text: '{"plan":{}}' }] });
    }) as PlansNav["ipcCallFn"];

    const nav = makeNav({ ipcCallFn: mockIpc });
    const consumed = handlePlansInput("a", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.state.statusMessage).toBe("Advancing...");
    expect(nav.state.statusType).toBe("info");
    expect(callArgs).toEqual([
      "callTool",
      { server: "test-server", tool: "advance_plan", arguments: { planId: "p1" } },
    ]);
  });

  it("advance passes stepId when plan is expanded", () => {
    let callArgs: unknown = null;
    const mockIpc = ((...args: unknown[]) => {
      callArgs = args;
      return Promise.resolve({ content: [{ type: "text", text: '{"plan":{}}' }] });
    }) as PlansNav["ipcCallFn"];

    const nav = makeNav({
      ipcCallFn: mockIpc,
      expandedPlan: { id: "p1", server: "test-server" },
      selectedStep: 1,
    });
    handlePlansInput("a", baseKey, nav);
    expect(callArgs).toEqual([
      "callTool",
      { server: "test-server", tool: "advance_plan", arguments: { planId: "p1", stepId: "s2" } },
    ]);
  });

  it("advance shows read-only message when server lacks capability", () => {
    const nav = makeNav({
      servers: [makeServer("test-server", ["list", "get"])],
    });
    const consumed = handlePlansInput("a", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.state.statusMessage).toBe("Read-only: server does not support advance_plan");
    expect(nav.state.statusType).toBe("warning");
  });

  it("advance shows gate error from server response", async () => {
    const mockIpc = (() =>
      Promise.resolve({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "gates not met",
              blockedGates: [{ name: "approval" }, { name: "tests" }],
            }),
          },
        ],
      })) as PlansNav["ipcCallFn"];

    const nav = makeNav({ ipcCallFn: mockIpc });
    handlePlansInput("a", baseKey, nav);
    // Poll for the async handler to complete
    await pollUntil(() => nav.state.statusMessage === "Gates blocking: approval, tests");
    expect(nav.state.statusMessage).toBe("Gates blocking: approval, tests");
    expect(nav.state.statusType).toBe("error");
  });

  it("advance is blocked while inflight", () => {
    let called = false;
    const mockIpc = (() => {
      called = true;
      return Promise.resolve({ content: [{ type: "text", text: "{}" }] });
    }) as PlansNav["ipcCallFn"];

    const nav = makeNav({ ipcCallFn: mockIpc, inflight: true });
    const consumed = handlePlansInput("a", baseKey, nav);
    expect(consumed).toBe(true);
    expect(called).toBe(false);
  });

  it("advance sets and clears inflight", async () => {
    const mockIpc = (() =>
      Promise.resolve({ content: [{ type: "text", text: '{"plan":{}}' }] })) as PlansNav["ipcCallFn"];

    const nav = makeNav({ ipcCallFn: mockIpc });
    handlePlansInput("a", baseKey, nav);
    expect(nav.state.inflight).toBe(true);
    await pollUntil(() => !(nav.state.inflight as boolean));
    expect(nav.state.inflight).toBe(false);
  });

  // -- Abort (x) --

  it("x enters abort confirmation mode", () => {
    const nav = makeNav();
    const consumed = handlePlansInput("x", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.state.confirmAbort).toBe(true);
    expect(nav.state.statusMessage).toContain("Abort plan");
    expect(nav.state.statusMessage).toContain("(y/n)");
    expect(nav.state.statusType).toBe("warning");
  });

  it("x shows read-only message when server lacks abort capability", () => {
    const nav = makeNav({
      servers: [makeServer("test-server", ["list", "get", "advance"])],
    });
    handlePlansInput("x", baseKey, nav);
    expect(nav.state.confirmAbort).toBe(false);
    expect(nav.state.statusMessage).toBe("Read-only: server does not support abort_plan");
    expect(nav.state.statusType).toBe("warning");
  });

  it("x is blocked while inflight", () => {
    const nav = makeNav({ inflight: true });
    const consumed = handlePlansInput("x", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.state.confirmAbort).toBe(false);
  });

  it("y confirms abort and calls ipc", () => {
    let callArgs: unknown = null;
    const mockIpc = ((...args: unknown[]) => {
      callArgs = args;
      return Promise.resolve({ content: [{ type: "text", text: '{"plan":{}}' }] });
    }) as PlansNav["ipcCallFn"];

    const nav = makeNav({ confirmAbort: true, ipcCallFn: mockIpc });
    const consumed = handlePlansInput("y", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.state.confirmAbort).toBe(false);
    expect(callArgs).toEqual(["callTool", { server: "test-server", tool: "abort_plan", arguments: { planId: "p1" } }]);
  });

  it("y handles missing plan gracefully", () => {
    const nav = makeNav({ confirmAbort: true, plans: [] });
    const consumed = handlePlansInput("y", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.state.confirmAbort).toBe(false);
    expect(nav.state.statusMessage).toContain("no longer exists");
    expect(nav.state.statusType).toBe("error");
  });

  it("n cancels abort confirmation", () => {
    const nav = makeNav({ confirmAbort: true });
    const consumed = handlePlansInput("n", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.state.confirmAbort).toBe(false);
    expect(nav.state.statusMessage).toBeNull();
    expect(nav.state.statusType).toBeNull();
  });

  it("any key other than y cancels abort confirmation", () => {
    const nav = makeNav({ confirmAbort: true });
    handlePlansInput("j", baseKey, nav);
    expect(nav.state.confirmAbort).toBe(false);
  });

  it("abort confirmation captures all input (does not navigate)", () => {
    const nav = makeNav({ confirmAbort: true, selectedIndex: 0 });
    handlePlansInput("j", baseKey, nav);
    // Should NOT have navigated — the confirm handler eats the input
    expect(nav.state.selectedIndex).toBe(0);
  });

  it("abort sets and clears inflight", async () => {
    const mockIpc = (() =>
      Promise.resolve({ content: [{ type: "text", text: '{"plan":{}}' }] })) as PlansNav["ipcCallFn"];

    const nav = makeNav({ confirmAbort: true, ipcCallFn: mockIpc });
    handlePlansInput("y", baseKey, nav);
    expect(nav.state.inflight).toBe(true);
    await pollUntil(() => !(nav.state.inflight as boolean));
    expect(nav.state.inflight).toBe(false);
  });

  // -- Refresh (r) --

  it("r calls refresh callback", () => {
    let refreshed = false;
    const nav = makeNav({
      refresh: () => {
        refreshed = true;
      },
    });
    const consumed = handlePlansInput("r", baseKey, nav);
    expect(consumed).toBe(true);
    expect(refreshed).toBe(true);
    expect(nav.state.statusMessage).toBe("Refreshing...");
    expect(nav.state.statusType).toBe("info");
  });

  it("r is debounced while already refreshing", () => {
    let refreshCount = 0;
    const nav = makeNav({
      statusMessage: "Refreshing...",
      refresh: () => {
        refreshCount++;
      },
    });
    handlePlansInput("r", baseKey, nav);
    expect(refreshCount).toBe(0);
  });

  it("r passes completion callback that clears status", () => {
    let onComplete: (() => void) | undefined;
    const nav = makeNav({
      refresh: (cb) => {
        onComplete = cb;
      },
    });
    handlePlansInput("r", baseKey, nav);
    expect(nav.state.statusMessage).toBe("Refreshing...");
    // Simulate refresh completion
    onComplete?.();
    expect(nav.state.statusMessage).toBeNull();
    expect(nav.state.statusType).toBeNull();
  });

  // -- Unrecognized input --

  it("returns false for unrecognized input", () => {
    const nav = makeNav();
    const consumed = handlePlansInput("z", baseKey, nav);
    expect(consumed).toBe(false);
  });
});

describe("clearPlansState", () => {
  it("clears confirmAbort, statusMessage, and statusType", () => {
    const nav = makeNav({
      confirmAbort: true,
      statusMessage: "Abort plan?",
      statusType: "warning",
    });
    clearPlansState(nav);
    expect(nav.state.confirmAbort).toBe(false);
    expect(nav.state.statusMessage).toBeNull();
    expect(nav.state.statusType).toBeNull();
  });
});

describe("hasCapability", () => {
  it("returns true when server has the capability", () => {
    const servers = [makeServer("srv", ["list", "advance"])];
    expect(hasCapability(servers, "srv", "advance")).toBe(true);
  });

  it("returns false when server lacks the capability", () => {
    const servers = [makeServer("srv", ["list", "get"])];
    expect(hasCapability(servers, "srv", "advance")).toBe(false);
  });

  it("returns false for unknown server", () => {
    const servers = [makeServer("srv", ["list", "advance"])];
    expect(hasCapability(servers, "unknown", "advance")).toBe(false);
  });

  it("returns false when server has no planCapabilities", () => {
    const servers = [makeServer("srv")];
    expect(hasCapability(servers, "srv", "advance")).toBe(false);
  });
});

describe("isPlanReadOnly", () => {
  it("returns true when server lacks both advance and abort", () => {
    const servers = [makeServer("srv", ["list", "get"])];
    const plan = makePlan({ id: "p1", server: "srv" });
    expect(isPlanReadOnly(servers, plan)).toBe(true);
  });

  it("returns false when server has advance", () => {
    const servers = [makeServer("srv", ["list", "advance"])];
    const plan = makePlan({ id: "p1", server: "srv" });
    expect(isPlanReadOnly(servers, plan)).toBe(false);
  });

  it("returns false when server has abort", () => {
    const servers = [makeServer("srv", ["list", "abort"])];
    const plan = makePlan({ id: "p1", server: "srv" });
    expect(isPlanReadOnly(servers, plan)).toBe(false);
  });
});
