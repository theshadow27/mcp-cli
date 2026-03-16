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

async function flush(ms = 10) {
  await Bun.sleep(ms);
}

/* ---------- usePlans tests ---------- */

describe("usePlans", () => {
  interface HookState {
    plans: Plan[];
    loading: boolean;
    error: string | null;
    disconnected: boolean;
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
      current: { plans: [], loading: true, error: null, disconnected: false },
    };
    const instance = render(React.createElement(Harness, { opts, stateRef }));
    instances.push(instance);
    return { instance, stateRef };
  }

  it("fetches plans from plan-capable servers on mount", async () => {
    const plan = makePlan("plan-1", "test-server");
    const ipcCallFn = async (method: string, params?: unknown) => {
      if (method === "status") return daemonStatus([{ name: "test-server", hasList: true }]);
      return planToolResult([plan]);
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await flush();

    expect(stateRef.current.plans).toHaveLength(1);
    expect(stateRef.current.plans[0].id).toBe("plan-1");
    expect(stateRef.current.loading).toBe(false);
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
      if (p.server === "server-a") return planToolResult([plan1]);
      if (p.server === "server-b") return planToolResult([plan2]);
      return planToolResult([]);
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await flush();

    expect(stateRef.current.plans).toHaveLength(2);
    expect(stateRef.current.loading).toBe(false);
  });

  it("skips servers without list capability", async () => {
    let callToolCallCount = 0;
    const ipcCallFn = async (method: string) => {
      if (method === "status") {
        return daemonStatus([{ name: "no-plan-server", hasList: false }]);
      }
      callToolCallCount++;
      return planToolResult([]);
    };

    mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await flush();

    expect(callToolCallCount).toBe(0);
  });

  it("sets disconnected and error when status call fails", async () => {
    const ipcCallFn = async () => {
      throw new Error("daemon offline");
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await flush();

    expect(stateRef.current.error).toBe("daemon offline");
    expect(stateRef.current.disconnected).toBe(true);
    expect(stateRef.current.loading).toBe(false);
  });

  it("does not poll when enabled=false", async () => {
    let callCount = 0;
    const ipcCallFn = async () => {
      callCount++;
      return daemonStatus([]);
    };

    mount({ enabled: false, ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await flush(30);

    expect(callCount).toBe(0);
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
      if (p.server === "bad-server") throw new Error("server unreachable");
      return planToolResult([plan]);
    };

    const { stateRef } = mount({ ipcCallFn: ipcCallFn as UsePlansOptions["ipcCallFn"] });
    await flush();

    // Plans from good server still returned; no top-level error
    expect(stateRef.current.plans).toHaveLength(1);
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
    await flush();

    expect(stateRef.current.plans).toHaveLength(0);
    expect(stateRef.current.disconnected).toBe(true);
    expect(stateRef.current.loading).toBe(false);
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
    await flush();

    expect(stateRef.current.plans).toHaveLength(0);
    expect(stateRef.current.disconnected).toBe(true);
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

    await flush(50);
    instance.unmount();
    instances.pop();
    const countAtUnmount = callCount;

    await flush(100);
    expect(callCount).toBe(countAtUnmount);
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
    await flush();

    expect(stateRef.current.plan?.id).toBe("plan-1");
    expect(stateRef.current.loading).toBe(false);
    expect(stateRef.current.error).toBeNull();
    expect(stateRef.current.disconnected).toBe(false);
  });

  it("exposes canAdvance=false by default", async () => {
    const plan = makePlan("plan-1", "srv");
    const ipcCallFn = async () => planDetailResult(plan);

    const { stateRef } = mount("plan-1", "srv", {
      ipcCallFn: ipcCallFn as UsePlanOptions["ipcCallFn"],
    });
    await flush();

    expect(stateRef.current.canAdvance).toBe(false);
  });

  it("exposes canAdvance=true when provided", async () => {
    const plan = makePlan("plan-1", "srv");
    const ipcCallFn = async () => planDetailResult(plan);

    const { stateRef } = mount("plan-1", "srv", {
      canAdvance: true,
      ipcCallFn: ipcCallFn as UsePlanOptions["ipcCallFn"],
    });
    await flush();

    expect(stateRef.current.canAdvance).toBe(true);
  });

  it("sets disconnected and error when callTool fails", async () => {
    const ipcCallFn = async () => {
      throw new Error("server offline");
    };

    const { stateRef } = mount("plan-1", "srv", {
      ipcCallFn: ipcCallFn as UsePlanOptions["ipcCallFn"],
    });
    await flush();

    expect(stateRef.current.error).toBe("server offline");
    expect(stateRef.current.disconnected).toBe(true);
    expect(stateRef.current.loading).toBe(false);
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
    await flush(30);

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
    await flush(30);

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
    await flush();

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
    await flush();

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

    await flush(100);
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

    await flush(50);
    instance.unmount();
    instances.pop();
    const countAtUnmount = callCount;

    await flush(100);
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

    await flush(30);
    expect(callCount).toBe(0);
  });
});
