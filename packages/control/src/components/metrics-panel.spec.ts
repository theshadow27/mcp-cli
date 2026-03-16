import { describe, expect, it } from "bun:test";
import type { PlanMetrics } from "@mcp-cli/core";
import { render } from "ink-testing-library";
import React from "react";
import { MetricsPanel } from "./metrics-panel";

function renderPanel(label: string, metrics: PlanMetrics) {
  return render(React.createElement(MetricsPanel, { label, metrics }));
}

describe("MetricsPanel", () => {
  it("renders key-value pairs from metrics", () => {
    const inst = renderPanel("deploy-dev", {
      Uptime: "99.98%",
      "Error rate": "0.02%",
      P99: 142,
    });

    const output = inst.lastFrame() ?? "";
    expect(output).toContain("Metrics (deploy-dev)");
    expect(output).toContain("Uptime:");
    expect(output).toContain("99.98%");
    expect(output).toContain("Error rate:");
    expect(output).toContain("0.02%");
    expect(output).toContain("P99:");
    expect(output).toContain("142");
    inst.unmount();
  });

  it("formats floating-point numbers to 2 decimal places", () => {
    const inst = renderPanel("step-1", { latency_ms: 142.567 });

    const output = inst.lastFrame() ?? "";
    expect(output).toContain("142.57");
    inst.unmount();
  });

  it("renders integer numbers without decimals", () => {
    const inst = renderPanel("step-1", { pods_ready: 3 });

    const output = inst.lastFrame() ?? "";
    expect(output).toContain("3");
    expect(output).not.toContain("3.");
    inst.unmount();
  });

  it("returns null when metrics is empty", () => {
    const inst = renderPanel("empty", {});

    const output = inst.lastFrame() ?? "";
    // Empty metrics should render nothing
    expect(output).toBe("");
    inst.unmount();
  });

  it("separates entries with pipe", () => {
    const inst = renderPanel("test", { a: 1, b: 2 });

    const output = inst.lastFrame() ?? "";
    expect(output).toContain("|");
    inst.unmount();
  });
});
