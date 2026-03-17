import { describe, expect, it } from "bun:test";
import type { Plan, ServerStatus } from "@mcp-cli/core";
import { render } from "ink-testing-library";
import React from "react";
import { PlansTab, STATUS_COLORS } from "./plans-tab";

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

function makeServer(name: string, capabilities: string[] = []): ServerStatus {
  return {
    name,
    state: "connected",
    source: "config",
    planCapabilities: capabilities.length > 0 ? { capabilities } : undefined,
  } as ServerStatus;
}

interface TabProps {
  plans?: Plan[];
  loading?: boolean;
  error?: string | null;
  disconnected?: boolean;
  failedServers?: string[];
  selectedIndex?: number;
  expandedPlan?: { id: string; server: string } | null;
  selectedStep?: number;
  servers?: ServerStatus[];
  statusMessage?: string | null;
  statusType?: "error" | "success" | "warning" | "info" | null;
  confirmAbort?: boolean;
}

function renderTab(props: TabProps = {}) {
  return render(
    React.createElement(PlansTab, {
      plans: props.plans ?? [makePlan()],
      loading: props.loading ?? false,
      error: props.error ?? null,
      disconnected: props.disconnected ?? false,
      failedServers: props.failedServers,
      selectedIndex: props.selectedIndex ?? 0,
      expandedPlan: props.expandedPlan ?? null,
      selectedStep: props.selectedStep ?? 0,
      servers: props.servers ?? [makeServer("deploy-server", ["list", "get", "advance", "abort"])],
      statusMessage: props.statusMessage ?? null,
      statusType: props.statusType ?? null,
      confirmAbort: props.confirmAbort ?? false,
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
    expect(output).toContain("●");
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

  it("shows partial failure warning with failed server names", () => {
    const inst = renderTab({ failedServers: ["auth-server", "deploy-server"] });
    const output = inst.lastFrame() ?? "";
    expect(output).toContain("2 server(s) unavailable");
    expect(output).toContain("auth-server");
    expect(output).toContain("deploy-server");
    inst.unmount();
  });

  it("prefers disconnected warning over partial failure warning", () => {
    const inst = renderTab({ disconnected: true, failedServers: ["auth-server"] });
    const output = inst.lastFrame() ?? "";
    expect(output).toContain("stale data");
    expect(output).not.toContain("unavailable");
    inst.unmount();
  });

  it("shows read-only badge when server lacks advance and abort", () => {
    const inst = renderTab({
      servers: [makeServer("deploy-server", ["list", "get"])],
    });
    expect(inst.lastFrame() ?? "").toContain("read-only");
    inst.unmount();
  });

  it("does not show read-only badge when server has advance", () => {
    const inst = renderTab({
      servers: [makeServer("deploy-server", ["list", "advance"])],
    });
    expect(inst.lastFrame() ?? "").not.toContain("read-only");
    inst.unmount();
  });

  it("shows status message when provided", () => {
    const inst = renderTab({ statusMessage: "Plan advanced" });
    expect(inst.lastFrame() ?? "").toContain("Plan advanced");
    inst.unmount();
  });

  it("does not show status message when null", () => {
    const inst = renderTab({ statusMessage: null });
    const output = inst.lastFrame() ?? "";
    expect(output).not.toContain("Plan advanced");
    inst.unmount();
  });
});

describe("STATUS_COLORS", () => {
  it("maps info to cyan (distinct from success)", () => {
    expect(STATUS_COLORS.info).toBe("cyan");
  });

  it("maps success to green", () => {
    expect(STATUS_COLORS.success).toBe("green");
  });

  it("info and success are distinct colors", () => {
    expect(STATUS_COLORS.info).not.toBe(STATUS_COLORS.success);
  });

  it("maps error to red", () => {
    expect(STATUS_COLORS.error).toBe("red");
  });

  it("maps warning to yellow", () => {
    expect(STATUS_COLORS.warning).toBe("yellow");
  });
});
