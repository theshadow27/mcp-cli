import { describe, expect, it } from "bun:test";
import type { Plan, PlanMetrics } from "@mcp-cli/core";
import { render } from "ink-testing-library";
import React from "react";
import { PlansTab } from "./plans-tab";

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "plan-1",
    name: "Deploy to prod",
    status: "active",
    server: "deploy-server",
    steps: [
      { id: "step-1", name: "Build", status: "complete" },
      { id: "step-2", name: "Deploy", status: "active" },
      { id: "step-3", name: "Verify", status: "pending" },
    ],
    activeStepId: "step-2",
    ...overrides,
  };
}

interface TabProps {
  plans?: Plan[];
  loading?: boolean;
  error?: string | null;
  disconnected?: boolean;
  selectedIndex?: number;
  metrics?: PlanMetrics | null;
  metricsLoading?: boolean;
}

function renderTab(props: TabProps = {}) {
  return render(
    React.createElement(PlansTab, {
      plans: props.plans ?? [makePlan()],
      loading: props.loading ?? false,
      error: props.error ?? null,
      disconnected: props.disconnected ?? false,
      selectedIndex: props.selectedIndex ?? 0,
      metrics: props.metrics ?? null,
      metricsLoading: props.metricsLoading ?? false,
    }),
  );
}

describe("PlansTab", () => {
  it("renders loading state", () => {
    const inst = renderTab({ plans: [], loading: true });
    expect(inst.lastFrame() ?? "").toContain("Loading plans...");
    inst.unmount();
  });

  it("renders error state", () => {
    const inst = renderTab({ plans: [], error: "daemon offline" });
    expect(inst.lastFrame() ?? "").toContain("Error: daemon offline");
    inst.unmount();
  });

  it("renders empty state", () => {
    const inst = renderTab({ plans: [] });
    expect(inst.lastFrame() ?? "").toContain("No plans available.");
    inst.unmount();
  });

  it("renders plan name, status, and step progress", () => {
    const inst = renderTab();
    const output = inst.lastFrame() ?? "";
    expect(output).toContain("Deploy to prod");
    expect(output).toContain("[active]");
    expect(output).toContain("1/3 steps");
    inst.unmount();
  });

  it("shows active step name", () => {
    const inst = renderTab();
    const output = inst.lastFrame() ?? "";
    expect(output).toContain("Deploy");
    inst.unmount();
  });

  it("shows server name", () => {
    const inst = renderTab();
    expect(inst.lastFrame() ?? "").toContain("deploy-server");
    inst.unmount();
  });

  it("shows disconnected warning", () => {
    const inst = renderTab({ disconnected: true });
    expect(inst.lastFrame() ?? "").toContain("stale data");
    inst.unmount();
  });

  it("renders metrics panel when metrics provided", () => {
    const metrics: PlanMetrics = { Uptime: "99.9%", Pods: "3/3 ready" };
    const inst = renderTab({ metrics });
    const output = inst.lastFrame() ?? "";
    expect(output).toContain("Metrics");
    expect(output).toContain("Uptime:");
    expect(output).toContain("99.9%");
    inst.unmount();
  });

  it("does not render metrics panel when metrics is null", () => {
    const inst = renderTab({ metrics: null });
    const output = inst.lastFrame() ?? "";
    expect(output).not.toContain("Metrics (");
    inst.unmount();
  });

  it("uses active step name as metrics label", () => {
    const metrics: PlanMetrics = { status: "ok" };
    const inst = renderTab({ metrics });
    const output = inst.lastFrame() ?? "";
    // Active step is "Deploy" (step-2)
    expect(output).toContain("Metrics (Deploy)");
    inst.unmount();
  });
});
