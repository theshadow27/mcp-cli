import { afterEach, describe, expect, it } from "bun:test";
import type { Plan, PlanMetrics } from "@mcp-cli/core";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React, { type FC } from "react";
import {
  type UsePlanMetricsOptions,
  type UsePlanOptions,
  type UsePlansOptions,
  usePlan,
  usePlanMetrics,
  usePlans,
} from "./use-plans";

/* ---------- fixtures ---------- */

function makePlan(id: string, server: string): Plan {
  return {
    id,
    name: `Plan ${id}`,
    status: "active",
    server,
    steps: [{ id: "step-1", name: "Step 1", status: "active" }],
    activeStepId: "step-1",
  };
}

function planToolResult(plans: Plan[]): object {
  return { content: [{ type: "text", text: JSON.stringify({ plans }) }] };
}

function planDetailResult(plan: Plan): object {
  return { content: [{ type: "text", text: JSON.stringify({ plan }) }] };
}

function metricsResult(metrics: PlanMetrics): object {
  return { content: [{ type: "text", text: JSON.stringify({ metrics }) }] };
}

function daemonStatus(servers: Array<{ name: string; hasList?: boolean; hasAdvance?: boolean; hasMetrics?: boolean }>) {
  return {
    pid: 1,
    uptime: 0,
    protocolVersion: "1",
    dbPath: "/tmp/db",
    servers: servers.map((s) => {
      const capabilities: string[] = [];
      if (s.hasList !== false) capabilities.push("list");
      if (s.hasAdvance) capabilities.push("advance");
      if (s.hasMetrics) capabilities.push("metrics");
      return {
        name: s.name,
        transport: "stdio" as const,
        state: "connected" as const,
        toolCount: 1,
        source: "test",
        planCapabilities: { capabilities },
      };
    }),
    usageStats: [],
  };
}

/** Poll a predicate until it returns true or the deadline expires. */
async function waitFor(predicate: () => boolean, deadlineMs = 2000): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > deadlineMs) {
      throw new Error(`waitFor timed out after ${deadlineMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

/* ---------- usePlans tests ---------- */

describe("usePlans", () => {
  interface HookState {
    plans: Plan[];
    loading: boolean;
    error: string | null;
    disconnected: boolean;
    failedServers: string[];
  }

  const instances: ReturnType<typeof render>[] = [];

  afterEach(() => {
    for (const inst of instances) inst.unmount();
    instances.length = 0;
  });

  const Harness: FC<{ opts: UsePlansOptions; stateRef: { current: HookState } }> = ({ opts, stateRef }) => {
    const result = usePlans(opts);
    stateRef.current = result;
    return React.createElement(Text, null, "ok");
  };

  function mount(opts: UsePlansOptions) {
    const stateRef: { current: HookState } = {
      current: { plans: [], loading: true, error: null, disconnected: false, failedServers: [] },
    };
    const instance = render(React.createElement(Harness, { opts, stateRef }));
    instances.push(instance);
    return { instance, stateRef };
  }

  it("fetches plans from plan-capable servers on mount", async () => {
    const plan = makePlan("plan-1", "test-server");
    const ipcCallFn = async (method: string, params?: unknown) => {
      if (method === "status") return daemonStatus([{ name: "test-server", hasList: true }]);
      const p = params as { server?: string };
      if (p.server === "_claude") return { content: [{ type: "text", text: "[]" }] };
      return planToolResult([plan]);
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await waitFor(() => stateRef.current.loading === false);

    expect(stateRef.current.plans).toHaveLength(1);
    expect(stateRef.current.plans[0].id).toBe("plan-1");
    expect(stateRef.current.error).toBeNull();
    expect(stateRef.current.disconnected).toBe(false);
  });

  it("aggregates plans from multiple plan-capable servers", async () => {
    const plan1 = makePlan("plan-1", "server-a");
    const plan2 = makePlan("plan-2", "server-b");
    const ipcCallFn = async (method: string, params?: unknown) => {
      if (method === "status") {
        return daemonStatus([
          { name: "server-a", hasList: true },
          { name: "server-b", hasList: true },
        ]);
      }
      const p = params as { server: string };
      if (p.server === "_claude") return { content: [{ type: "text", text: "[]" }] };
      if (p.server === "server-a") return planToolResult([plan1]);
      if (p.server === "server-b") return planToolResult([plan2]);
      return planToolResult([]);
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await waitFor(() => stateRef.current.loading === false);

    expect(stateRef.current.plans).toHaveLength(2);
  });

  it("sorts plans deterministically by server then id", async () => {
    const planB = makePlan("plan-b", "server-z");
    const planA = makePlan("plan-a", "server-a");
    const ipcCallFn = async (method: string, params?: unknown) => {
      if (method === "status") {
        return daemonStatus([
          { name: "server-z", hasList: true },
          { name: "server-a", hasList: true },
        ]);
      }
      const p = params as { server: string };
      if (p.server === "_claude") return { content: [{ type: "text", text: "[]" }] };
      if (p.server === "server-z") return planToolResult([planB]);
      if (p.server === "server-a") return planToolResult([planA]);
      return planToolResult([]);
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await waitFor(() => stateRef.current.loading === false);

    expect(stateRef.current.plans[0].server).toBe("server-a");
    expect(stateRef.current.plans[1].server).toBe("server-z");
  });

  it("skips servers without list capability", async () => {
    let planServerCallCount = 0;
    const ipcCallFn = async (method: string, params?: unknown) => {
      if (method === "status") {
        return daemonStatus([{ name: "no-plan-server", hasList: false }]);
      }
      const p = params as { server?: string } | undefined;
      if (p?.server === "no-plan-server") planServerCallCount++;
      // Return empty for _claude calls
      return { content: [{ type: "text", text: "[]" }] };
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await waitFor(() => stateRef.current.loading === false);

    expect(planServerCallCount).toBe(0);
  });

  it("sets disconnected and error when status call fails", async () => {
    const ipcCallFn = async () => {
      throw new Error("daemon offline");
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await waitFor(() => stateRef.current.loading === false);

    expect(stateRef.current.error).toBe("daemon offline");
    expect(stateRef.current.disconnected).toBe(true);
  });

  it("does not poll when enabled=false", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return daemonStatus([]);
    };

    mount({ enabled: false, ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    // Give a short window to confirm no calls are made
    await new Promise((r) => setTimeout(r, 30));

    expect(callCount).toBe(0);
  });

  it("resets loading=true when enabled transitions false→true (#775)", async () => {
    const plan = makePlan("plan-1", "test-server");
    let pollDelay = 0;
    const ipcCallFn = async (method: string, params?: unknown) => {
      if (method === "status") {
        if (pollDelay > 0) await new Promise((r) => setTimeout(r, pollDelay));
        return daemonStatus([{ name: "test-server", hasList: true }]);
      }
      const p = params as { server?: string };
      if (p.server === "_claude") return { content: [{ type: "text", text: "[]" }] };
      return planToolResult([plan]);
    };

    // Wrapper that lets us toggle enabled and tracks render count
    let setEnabled: ((v: boolean) => void) | undefined;
    let renderCount = 0;
    const stateRef: { current: HookState } = {
      current: { plans: [], loading: true, error: null, disconnected: false, failedServers: [] },
    };
    const Wrapper: FC = () => {
      const [enabled, _setEnabled] = React.useState(true);
      setEnabled = _setEnabled;
      const result = usePlans({
        enabled,
        intervalMs: 60_000,
        ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"],
      });
      stateRef.current = result;
      renderCount++;
      return React.createElement(Text, null, "ok");
    };

    const instance = render(React.createElement(Wrapper));
    instances.push(instance);

    // Wait for first poll to complete — loading becomes false
    await waitFor(() => stateRef.current.loading === false);
    expect(stateRef.current.plans).toHaveLength(1);

    // Disable — effect cleanup runs; wait for React to process the update
    const countBeforeDisable = renderCount;
    setEnabled?.(false);
    await waitFor(() => renderCount > countBeforeDisable);

    // Make next poll slow so we can observe loading=true before it completes
    pollDelay = 200;

    // Re-enable — loading should reset to true immediately
    setEnabled?.(true);
    await waitFor(() => stateRef.current.loading === true);

    // Eventually poll completes
    await waitFor(() => stateRef.current.loading === false);
    expect(stateRef.current.plans).toHaveLength(1);
  });

  it("continues when one server's callTool fails", async () => {
    const plan = makePlan("plan-1", "good-server");
    const ipcCallFn = async (method: string, params?: unknown) => {
      if (method === "status") {
        return daemonStatus([
          { name: "good-server", hasList: true },
          { name: "bad-server", hasList: true },
        ]);
      }
      const p = params as { server: string };
      if (p.server === "_claude") return { content: [{ type: "text", text: "[]" }] };
      if (p.server === "bad-server") throw new Error("server unreachable");
      return planToolResult([plan]);
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await waitFor(() => stateRef.current.loading === false);

    // Plans from good server still returned; no top-level error
    expect(stateRef.current.plans).toHaveLength(1);
    expect(stateRef.current.error).toBeNull();
  });

  it("reports failedServers when one server fails and another succeeds", async () => {
    const plan = makePlan("plan-1", "good-server");
    const ipcCallFn = async (method: string, params?: unknown) => {
      if (method === "status") {
        return daemonStatus([
          { name: "good-server", hasList: true },
          { name: "bad-server", hasList: true },
        ]);
      }
      const p = params as { server: string };
      if (p.server === "_claude") return { content: [{ type: "text", text: "[]" }] };
      if (p.server === "bad-server") throw new Error("server unreachable");
      return planToolResult([plan]);
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await waitFor(() => stateRef.current.loading === false);

    expect(stateRef.current.failedServers).toEqual(["bad-server"]);
    expect(stateRef.current.disconnected).toBe(false);
  });

  it("reports failedServers when a server returns unparseable response", async () => {
    const plan = makePlan("plan-1", "good-server");
    const ipcCallFn = async (method: string, params?: unknown) => {
      if (method === "status") {
        return daemonStatus([
          { name: "good-server", hasList: true },
          { name: "bad-schema-server", hasList: true },
        ]);
      }
      const p = params as { server: string };
      if (p.server === "_claude") return { content: [{ type: "text", text: "[]" }] };
      if (p.server === "bad-schema-server") {
        return { content: [{ type: "text", text: JSON.stringify({ wrong: "shape" }) }] };
      }
      return planToolResult([plan]);
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await waitFor(() => stateRef.current.loading === false);

    expect(stateRef.current.failedServers).toEqual(["bad-schema-server"]);
    expect(stateRef.current.plans).toHaveLength(1);
    expect(stateRef.current.disconnected).toBe(false);
  });

  it("clears failedServers when all servers succeed", async () => {
    const plan = makePlan("plan-1", "server-a");
    const ipcCallFn = async (method: string, params?: unknown) => {
      if (method === "status") return daemonStatus([{ name: "server-a", hasList: true }]);
      const p = params as { server?: string };
      if (p.server === "_claude") return { content: [{ type: "text", text: "[]" }] };
      return planToolResult([plan]);
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await waitFor(() => stateRef.current.loading === false);

    expect(stateRef.current.failedServers).toEqual([]);
  });

  it("treats a hanging server as a failure (per-server IPC timeout)", async () => {
    const plan = makePlan("plan-1", "fast-server");
    const ipcCallFn = async (method: string, params?: unknown) => {
      if (method === "status") {
        return daemonStatus([
          { name: "fast-server", hasList: true },
          { name: "slow-server", hasList: true },
        ]);
      }
      const p = params as { server: string };
      if (p.server === "_claude") return { content: [{ type: "text", text: "[]" }] };
      if (p.server === "slow-server") {
        // Simulate a server that never responds — will be killed by timeout
        return new Promise<never>(() => {});
      }
      return planToolResult([plan]);
    };

    // Use a short timeout so the test completes quickly
    const { stateRef } = mount({
      timeoutMs: 200,
      ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"],
    });
    // The fast server should return results even though slow server hangs.
    // Promise.allSettled waits for all promises, so we need the timeout to kick in.
    await waitFor(() => stateRef.current.loading === false, 3_000);

    expect(stateRef.current.plans).toHaveLength(1);
    expect(stateRef.current.plans[0].id).toBe("plan-1");
    expect(stateRef.current.error).toBeNull();
  });

  it("sets disconnected when all plan servers fail", async () => {
    const ipcCallFn = async (method: string) => {
      if (method === "status") {
        return daemonStatus([
          { name: "server-a", hasList: true },
          { name: "server-b", hasList: true },
        ]);
      }
      throw new Error("server unreachable");
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await waitFor(() => stateRef.current.loading === false);

    expect(stateRef.current.plans).toHaveLength(0);
    expect(stateRef.current.disconnected).toBe(true);
    expect(stateRef.current.error).toBeNull();
  });

  it("sets disconnected when all servers return unparseable responses", async () => {
    const ipcCallFn = async (method: string) => {
      if (method === "status") {
        return daemonStatus([{ name: "server-a", hasList: true }]);
      }
      return { content: [{ type: "text", text: "not valid json{" }] };
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await waitFor(() => stateRef.current.loading === false);

    expect(stateRef.current.plans).toHaveLength(0);
    expect(stateRef.current.disconnected).toBe(true);
  });

  it("logs console.error when safeParse fails for a server (#762)", async () => {
    const errors: unknown[][] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);

    try {
      const ipcCallFn = async (method: string) => {
        if (method === "status") {
          return daemonStatus([{ name: "bad-schema-server", hasList: true }]);
        }
        // Valid JSON but wrong shape — safeParse will fail
        return { content: [{ type: "text", text: JSON.stringify({ wrong: "shape" }) }] };
      };

      const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
      await waitFor(() => stateRef.current.loading === false);

      const parseErrors = errors.filter(
        (args) => typeof args[0] === "string" && args[0].includes("[usePlans] parse error"),
      );
      expect(parseErrors.length).toBeGreaterThanOrEqual(1);
      expect(parseErrors[0][0]).toContain("bad-schema-server");
    } finally {
      console.error = origError;
    }
  });

  it("cleanup stops polling on unmount", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return daemonStatus([]);
    };

    const { instance } = mount({
      intervalMs: 30,
      ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"],
    });

    await waitFor(() => callCount >= 2);
    instance.unmount();
    instances.pop();
    const countAtUnmount = callCount;

    // Wait and confirm no more calls after unmount
    await new Promise((r) => setTimeout(r, 100));
    expect(callCount).toBe(countAtUnmount);
  });

  it("sorts plans by server then id (deterministic order)", async () => {
    const planB = makePlan("b-plan", "z-server");
    const planA = makePlan("a-plan", "a-server");
    const ipcCallFn = async (method: string, params?: unknown) => {
      if (method === "status") {
        return daemonStatus([
          { name: "z-server", hasList: true },
          { name: "a-server", hasList: true },
        ]);
      }
      const p = params as { server: string };
      if (p.server === "_claude") return { content: [{ type: "text", text: "[]" }] };
      if (p.server === "z-server") return planToolResult([planB]);
      if (p.server === "a-server") return planToolResult([planA]);
      return planToolResult([]);
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await waitFor(() => stateRef.current.plans.length >= 2);

    expect(stateRef.current.plans[0].server).toBe("a-server");
    expect(stateRef.current.plans[1].server).toBe("z-server");
  });
});

/* ---------- step clamp integration test ---------- */

describe("step clamp effect (app.tsx:149-155 integration)", () => {
  /**
   * This tests the critical #748 fix: when a poll returns fewer steps for an
   * expanded plan, the selectedStep must be clamped to the new bounds.
   * We replicate the useEffect from app.tsx in a minimal harness.
   */
  const instances: ReturnType<typeof render>[] = [];

  afterEach(() => {
    for (const inst of instances) inst.unmount();
    instances.length = 0;
  });

  interface ClampState {
    plans: Plan[];
    selectedStep: number;
  }

  const ClampHarness: FC<{
    opts: UsePlansOptions;
    expandedPlan: { id: string; server: string };
    initialStep: number;
    stateRef: { current: ClampState };
  }> = ({ opts, expandedPlan, initialStep, stateRef }) => {
    const { plans: plansData } = usePlans(opts);
    const [selectedStep, setSelectedStep] = React.useState(initialStep);

    // This is the exact clamp effect from app.tsx:149-155
    React.useEffect(() => {
      if (expandedPlan === null) return;
      const expanded = plansData.find((p) => p.id === expandedPlan.id && p.server === expandedPlan.server);
      if (expanded) {
        setSelectedStep((i) => Math.min(i, Math.max(0, expanded.steps.length - 1)));
      }
    }, [plansData, expandedPlan]);

    stateRef.current = { plans: plansData, selectedStep };
    return React.createElement(Text, null, `step:${selectedStep}`);
  };

  it("clamps selectedStep when plan steps shrink on re-poll", async () => {
    const threeStepPlan: Plan = {
      id: "plan-1",
      name: "Test Plan",
      status: "active",
      server: "srv",
      steps: [
        { id: "s1", name: "Step 1", status: "complete" },
        { id: "s2", name: "Step 2", status: "complete" },
        { id: "s3", name: "Step 3", status: "active" },
      ],
      activeStepId: "s3",
    };
    const oneStepPlan: Plan = {
      ...threeStepPlan,
      steps: [{ id: "s1", name: "Step 1", status: "complete" }],
      activeStepId: "s1",
    };

    let pollCount = 0;
    const ipcCallFn = async (method: string, params?: unknown) => {
      if (method === "status") return daemonStatus([{ name: "srv", hasList: true }]);
      const p = params as { server?: string };
      if (p.server === "_claude") return { content: [{ type: "text", text: "[]" }] };
      pollCount++;
      // First poll: 3 steps; subsequent polls: 1 step
      return planToolResult([pollCount <= 1 ? threeStepPlan : oneStepPlan]);
    };

    const stateRef: { current: ClampState } = {
      current: { plans: [], selectedStep: 2 },
    };

    const instance = render(
      React.createElement(ClampHarness, {
        opts: { intervalMs: 40, ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] },
        expandedPlan: { id: "plan-1", server: "srv" },
        initialStep: 2, // pointing at step index 2 (the third step)
        stateRef,
      }),
    );
    instances.push(instance);

    // Wait for first poll — selectedStep stays at 2 (valid for 3-step plan)
    await waitFor(() => stateRef.current.plans.length >= 1);
    expect(stateRef.current.plans).toHaveLength(1);
    expect(stateRef.current.selectedStep).toBe(2);

    // Wait for second poll and clamp effect to settle
    await waitFor(() => stateRef.current.selectedStep === 0);
    expect(pollCount).toBeGreaterThanOrEqual(2);
    expect(stateRef.current.plans[0].steps).toHaveLength(1);
    expect(stateRef.current.selectedStep).toBe(0);
  });
});

/* ---------- cursor drift fix (issue #763) ---------- */

describe("cursor snaps to expanded plan on reorder (issue #763)", () => {
  const instances: ReturnType<typeof render>[] = [];

  afterEach(() => {
    for (const inst of instances) inst.unmount();
    instances.length = 0;
  });

  interface DriftState {
    plans: Plan[];
    selectedIndex: number;
  }

  const DriftHarness: FC<{
    opts: UsePlansOptions;
    expandedPlan: { id: string; server: string } | null;
    stateRef: { current: DriftState };
  }> = ({ opts, expandedPlan, stateRef }) => {
    const { plans } = usePlans(opts);
    const [selectedIndex, setSelectedIndex] = React.useState(0);
    const plansSelectionIdRef = React.useRef<{ server: string; id: string } | null>(null);

    // Replicate the fixed effect from app.tsx: prioritize expandedPlan
    React.useEffect(() => {
      if (expandedPlan && plans.length > 0) {
        const idx = plans.findIndex((p) => p.server === expandedPlan.server && p.id === expandedPlan.id);
        if (idx >= 0) {
          setSelectedIndex(idx);
          plansSelectionIdRef.current = { server: expandedPlan.server, id: expandedPlan.id };
          return;
        }
      }
      const id = plansSelectionIdRef.current;
      if (id && plans.length > 0) {
        const idx = plans.findIndex((p) => p.server === id.server && p.id === id.id);
        if (idx >= 0) {
          setSelectedIndex(idx);
          return;
        }
      }
      setSelectedIndex((i) => Math.min(i, Math.max(0, plans.length - 1)));
    }, [plans, expandedPlan]);

    stateRef.current = { plans, selectedIndex };
    return React.createElement(Text, null, `idx:${selectedIndex}`);
  };

  it("snaps cursor to expanded plan when a new plan sorts before it", async () => {
    const planB = makePlan("plan-b", "server-b");
    const planA = makePlan("plan-a", "server-a");

    let pollRound = 0;
    const ipcCallFn = async (method: string, params?: unknown) => {
      if (method === "status") {
        return daemonStatus([
          { name: "server-a", hasList: true },
          { name: "server-b", hasList: true },
        ]);
      }
      const p = params as { server: string };
      if (p.server === "_claude") return { content: [{ type: "text", text: "[]" }] };
      if (p.server === "server-b") {
        pollRound++;
        return planToolResult([planB]);
      }
      // server-a: empty on first round, returns plan-a on second
      if (pollRound <= 1) return planToolResult([]);
      return planToolResult([planA]);
    };

    const stateRef: { current: DriftState } = {
      current: { plans: [], selectedIndex: 0 },
    };

    const instance = render(
      React.createElement(DriftHarness, {
        opts: { intervalMs: 40, ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] },
        expandedPlan: { id: "plan-b", server: "server-b" },
        stateRef,
      }),
    );
    instances.push(instance);

    // Wait for initial load — plan-b is the only plan at index 0
    await waitFor(() => stateRef.current.plans.length >= 1 && stateRef.current.plans[0].id === "plan-b");
    expect(stateRef.current.selectedIndex).toBe(0);

    // Wait for re-poll with both plans — plan-a (server-a) sorts before plan-b (server-b)
    await waitFor(() => stateRef.current.plans.length === 2);
    // Cursor must follow the expanded plan (plan-b) to its new index (1)
    expect(stateRef.current.plans[0].id).toBe("plan-a");
    expect(stateRef.current.plans[1].id).toBe("plan-b");
    expect(stateRef.current.selectedIndex).toBe(1);
  });
});

/* ---------- usePlans: Claude plan integration ---------- */

describe("usePlans — Claude plan integration", () => {
  interface HookState {
    plans: Plan[];
    loading: boolean;
    error: string | null;
    disconnected: boolean;
    failedServers: string[];
  }

  const instances: ReturnType<typeof render>[] = [];

  afterEach(() => {
    for (const inst of instances) inst.unmount();
    instances.length = 0;
  });

  const Harness: FC<{ opts: UsePlansOptions; stateRef: { current: HookState } }> = ({ opts, stateRef }) => {
    const result = usePlans(opts);
    stateRef.current = result;
    return React.createElement(Text, null, "ok");
  };

  function mount(opts: UsePlansOptions) {
    const stateRef: { current: HookState } = {
      current: { plans: [], loading: true, error: null, disconnected: false, failedServers: [] },
    };
    const instance = render(React.createElement(Harness, { opts, stateRef }));
    instances.push(instance);
    return { instance, stateRef };
  }

  /** Helper: build a claude_plans tool response containing Plan[] */
  function claudePlansResult(plans: Plan[]): object {
    return { content: [{ type: "text", text: JSON.stringify(plans) }] };
  }

  it("merges Claude session plans alongside server plans", async () => {
    const serverPlan = makePlan("server-plan", "test-server");
    const claudePlan: Plan = {
      id: "claude-sess-1",
      name: "Session sess-1",
      status: "active",
      server: "_claude",
      steps: [{ id: "t1", name: "Build feature", status: "active" }],
      activeStepId: "t1",
    };
    const ipcCallFn = async (method: string, params?: unknown) => {
      if (method === "status") return daemonStatus([{ name: "test-server", hasList: true }]);

      const p = params as { server?: string; tool?: string };
      if (p.server === "test-server") return planToolResult([serverPlan]);

      // _claude server: claude_plans tool
      if (p.tool === "claude_plans") return claudePlansResult([claudePlan]);
      return { content: [{ type: "text", text: "[]" }] };
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await waitFor(() => !stateRef.current.loading);

    expect(stateRef.current.plans.length).toBeGreaterThanOrEqual(2);
    const cp = stateRef.current.plans.find((p) => p.server === "_claude");
    expect(cp).toBeDefined();
    expect(cp?.steps[0].name).toBe("Build feature");
  });

  it("returns only server plans when _claude server is unavailable", async () => {
    const serverPlan = makePlan("server-plan", "test-server");
    const ipcCallFn = async (method: string, params?: unknown) => {
      if (method === "status") return daemonStatus([{ name: "test-server", hasList: true }]);

      const p = params as { server?: string; tool?: string };
      if (p.server === "test-server") return planToolResult([serverPlan]);
      // _claude calls throw
      throw new Error("_claude not available");
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await waitFor(() => !stateRef.current.loading);

    expect(stateRef.current.plans).toHaveLength(1);
    expect(stateRef.current.plans[0].id).toBe("server-plan");
    expect(stateRef.current.error).toBeNull();
  });

  it("returns empty Claude plans when claude_plans returns empty array", async () => {
    const ipcCallFn = async (method: string, params?: unknown) => {
      if (method === "status") return daemonStatus([]);

      const p = params as { tool?: string };
      if (p.tool === "claude_plans") return claudePlansResult([]);
      return { content: [{ type: "text", text: "[]" }] };
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await waitFor(() => !stateRef.current.loading);

    const cp = stateRef.current.plans.filter((p) => p.server === "_claude");
    expect(cp).toHaveLength(0);
  });

  it("handles claude_plans timeout gracefully", async () => {
    const ipcCallFn = async (method: string, params?: unknown) => {
      if (method === "status") return daemonStatus([]);

      const p = params as { tool?: string };
      if (p.tool === "claude_plans") {
        // Simulate a server that never responds
        return new Promise<never>(() => {});
      }
      return { content: [{ type: "text", text: "[]" }] };
    };

    const { stateRef } = mount({
      timeoutMs: 100,
      ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"],
    });
    await waitFor(() => !stateRef.current.loading, 3_000);

    // Should complete without error — timeout is caught internally
    const cp = stateRef.current.plans.filter((p) => p.server === "_claude");
    expect(cp).toHaveLength(0);
    expect(stateRef.current.error).toBeNull();
  });
});

/* ---------- usePlan tests ---------- */

describe("usePlan", () => {
  interface HookState {
    plan: Plan | null;
    loading: boolean;
    error: string | null;
    canAdvance: boolean;
    disconnected: boolean;
  }

  const instances: ReturnType<typeof render>[] = [];

  afterEach(() => {
    for (const inst of instances) inst.unmount();
    instances.length = 0;
  });

  const Harness: FC<{
    planId: string;
    server: string;
    opts: UsePlanOptions;
    stateRef: { current: HookState };
  }> = ({ planId, server, opts, stateRef }) => {
    const result = usePlan(planId, server, opts);
    stateRef.current = result;
    return React.createElement(Text, null, "ok");
  };

  function mount(planId: string, server: string, opts: UsePlanOptions) {
    const stateRef: { current: HookState } = {
      current: { plan: null, loading: true, error: null, canAdvance: false, disconnected: false },
    };
    const instance = render(React.createElement(Harness, { planId, server, opts, stateRef }));
    instances.push(instance);
    return { instance, stateRef };
  }

  it("fetches plan on mount", async () => {
    const plan = makePlan("plan-1", "srv");
    const ipcCallFn = async () => planDetailResult(plan);

    const { stateRef } = mount("plan-1", "srv", {
      ipcCallFn: ipcCallFn as UsePlanOptions["ipcCallFn"],
    });
    await waitFor(() => stateRef.current.loading === false);

    expect(stateRef.current.plan?.id).toBe("plan-1");
    expect(stateRef.current.error).toBeNull();
    expect(stateRef.current.disconnected).toBe(false);
  });

  it("exposes canAdvance=false by default", async () => {
    const plan = makePlan("plan-1", "srv");
    const ipcCallFn = async () => planDetailResult(plan);

    const { stateRef } = mount("plan-1", "srv", {
      ipcCallFn: ipcCallFn as UsePlanOptions["ipcCallFn"],
    });
    await waitFor(() => stateRef.current.loading === false);

    expect(stateRef.current.canAdvance).toBe(false);
  });

  it("exposes canAdvance=true when provided", async () => {
    const plan = makePlan("plan-1", "srv");
    const ipcCallFn = async () => planDetailResult(plan);

    const { stateRef } = mount("plan-1", "srv", {
      canAdvance: true,
      ipcCallFn: ipcCallFn as UsePlanOptions["ipcCallFn"],
    });
    await waitFor(() => stateRef.current.loading === false);

    expect(stateRef.current.canAdvance).toBe(true);
  });

  it("sets disconnected and error when callTool fails", async () => {
    const ipcCallFn = async () => {
      throw new Error("server offline");
    };

    const { stateRef } = mount("plan-1", "srv", {
      ipcCallFn: ipcCallFn as UsePlanOptions["ipcCallFn"],
    });
    await waitFor(() => stateRef.current.loading === false);

    expect(stateRef.current.error).toBe("server offline");
    expect(stateRef.current.disconnected).toBe(true);
  });

  it("does not fetch when enabled=false", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return planDetailResult(makePlan("plan-1", "srv"));
    };

    mount("plan-1", "srv", {
      enabled: false,
      ipcCallFn: ipcCallFn as UsePlanOptions["ipcCallFn"],
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(callCount).toBe(0);
  });
});

/* ---------- usePlanMetrics tests ---------- */

describe("usePlanMetrics", () => {
  interface HookState {
    metrics: PlanMetrics | null;
    loading: boolean;
    error: string | null;
  }

  const instances: ReturnType<typeof render>[] = [];

  afterEach(() => {
    for (const inst of instances) inst.unmount();
    instances.length = 0;
  });

  const Harness: FC<{
    planId: string;
    stepId: string | undefined;
    server: string;
    opts: UsePlanMetricsOptions;
    stateRef: { current: HookState };
  }> = ({ planId, stepId, server, opts, stateRef }) => {
    const result = usePlanMetrics(planId, stepId, server, opts);
    stateRef.current = result;
    return React.createElement(Text, null, "ok");
  };

  function mount(planId: string, stepId: string | undefined, server: string, opts: UsePlanMetricsOptions) {
    const stateRef: { current: HookState } = {
      current: { metrics: null, loading: false, error: null },
    };
    const instance = render(React.createElement(Harness, { planId, stepId, server, opts, stateRef }));
    instances.push(instance);
    return { instance, stateRef };
  }

  it("returns null immediately when supportsMetrics=false", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return metricsResult({ steps_complete: 1 });
    };

    const { stateRef } = mount("plan-1", "step-1", "srv", {
      supportsMetrics: false,
      ipcCallFn: ipcCallFn as UsePlanMetricsOptions["ipcCallFn"],
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(callCount).toBe(0);
    expect(stateRef.current.metrics).toBeNull();
    expect(stateRef.current.loading).toBe(false);
  });

  it("polls metrics when supportsMetrics=true", async () => {
    const metrics: PlanMetrics = { steps_complete: 2, duration_ms: 1234 };
    const ipcCallFn = async () => metricsResult(metrics);

    const { stateRef } = mount("plan-1", "step-1", "srv", {
      supportsMetrics: true,
      ipcCallFn: ipcCallFn as UsePlanMetricsOptions["ipcCallFn"],
    });
    await waitFor(() => stateRef.current.metrics !== null);

    expect(stateRef.current.metrics).toEqual(metrics);
    expect(stateRef.current.loading).toBe(false);
    expect(stateRef.current.error).toBeNull();
  });

  it("sets error when callTool fails", async () => {
    const ipcCallFn = async () => {
      throw new Error("metrics unavailable");
    };

    const { stateRef } = mount("plan-1", "step-1", "srv", {
      supportsMetrics: true,
      ipcCallFn: ipcCallFn as UsePlanMetricsOptions["ipcCallFn"],
    });
    await waitFor(() => stateRef.current.error !== null);

    expect(stateRef.current.error).toBe("metrics unavailable");
    expect(stateRef.current.loading).toBe(false);
  });

  it("polls repeatedly at intervalMs", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return metricsResult({});
    };

    mount("plan-1", "step-1", "srv", {
      supportsMetrics: true,
      intervalMs: 30,
      ipcCallFn: ipcCallFn as UsePlanMetricsOptions["ipcCallFn"],
    });

    await waitFor(() => callCount >= 3);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("cleanup stops polling on unmount", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return metricsResult({});
    };

    const { instance } = mount("plan-1", "step-1", "srv", {
      supportsMetrics: true,
      intervalMs: 30,
      ipcCallFn: ipcCallFn as UsePlanMetricsOptions["ipcCallFn"],
    });

    await waitFor(() => callCount >= 2);
    instance.unmount();
    instances.pop();
    const countAtUnmount = callCount;

    await new Promise((r) => setTimeout(r, 100));
    expect(callCount).toBe(countAtUnmount);
  });

  it("does not poll when enabled=false", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return metricsResult({});
    };

    mount("plan-1", "step-1", "srv", {
      supportsMetrics: true,
      enabled: false,
      ipcCallFn: ipcCallFn as UsePlanMetricsOptions["ipcCallFn"],
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(callCount).toBe(0);
  });

  it("clears stale metrics when planId changes", async () => {
    const metrics1: PlanMetrics = { steps_complete: 2 };
    const metrics2: PlanMetrics = { steps_complete: 5 };
    let currentPlanId = "plan-1";
    const ipcCallFn = async () => {
      return metricsResult(currentPlanId === "plan-1" ? metrics1 : metrics2);
    };

    // Use a wrapper that re-renders with new planId
    const stateRef: { current: { metrics: PlanMetrics | null; loading: boolean; error: string | null } } = {
      current: { metrics: null, loading: false, error: null },
    };
    let setPlanId: ((id: string) => void) | undefined;
    const Wrapper: FC = () => {
      const [planId, _setPlanId] = React.useState("plan-1");
      setPlanId = _setPlanId;
      const result = usePlanMetrics(planId, "step-1", "srv", {
        supportsMetrics: true,
        ipcCallFn: ipcCallFn as UsePlanMetricsOptions["ipcCallFn"],
      });
      stateRef.current = result;
      return React.createElement(Text, null, "ok");
    };

    const instance = render(React.createElement(Wrapper));
    instances.push(instance);

    await waitFor(() => stateRef.current.metrics !== null);
    expect(stateRef.current.metrics).toEqual(metrics1);

    // Switch plan — metrics should clear before new poll completes
    currentPlanId = "plan-2";
    setPlanId?.("plan-2");

    // The metrics should first clear to null (stale cleared)
    await waitFor(() => stateRef.current.metrics === null || stateRef.current.metrics?.steps_complete === 5);

    // Then eventually resolve to new metrics
    await waitFor(() => stateRef.current.metrics !== null);
    expect(stateRef.current.metrics).toEqual(metrics2);
  });
});
