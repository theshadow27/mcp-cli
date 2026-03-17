import { describe, expect, it } from "bun:test";
import type { PlanGate } from "@mcp-cli/core";
import { render } from "ink-testing-library";
import React from "react";
import { GatePanel } from "./gate-panel";

function renderPanel(gates: PlanGate[], stepName = "Build") {
  const inst = render(React.createElement(GatePanel, { gates, stepName }));
  return inst;
}

describe("GatePanel", () => {
  it("returns null for empty gates", () => {
    const inst = renderPanel([]);
    expect(inst.lastFrame()).toBe("");
    inst.unmount();
  });

  it("shows step name header", () => {
    const gates: PlanGate[] = [{ name: "security-scan", passed: true }];
    const inst = renderPanel(gates, "Deploy");
    expect(inst.lastFrame() ?? "").toContain("Gates for Deploy:");
    inst.unmount();
  });

  it("shows passed gate with checkmark", () => {
    const gates: PlanGate[] = [{ name: "lint", passed: true }];
    const inst = renderPanel(gates);
    expect(inst.lastFrame() ?? "").toContain("✓ lint");
    inst.unmount();
  });

  it("shows failed gate with circle", () => {
    const gates: PlanGate[] = [{ name: "tests", passed: false }];
    const inst = renderPanel(gates);
    expect(inst.lastFrame() ?? "").toContain("○ tests");
    inst.unmount();
  });

  it("shows gate description when provided", () => {
    const gates: PlanGate[] = [{ name: "review", passed: false, description: "Awaiting approval" }];
    const inst = renderPanel(gates);
    expect(inst.lastFrame() ?? "").toContain("Awaiting approval");
    inst.unmount();
  });

  it("omits description when not provided", () => {
    const gates: PlanGate[] = [{ name: "review", passed: true }];
    const inst = renderPanel(gates);
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("review");
    expect(frame).not.toContain("—");
    inst.unmount();
  });

  it("renders multiple gates", () => {
    const gates: PlanGate[] = [
      { name: "lint", passed: true },
      { name: "tests", passed: false },
      { name: "security", passed: true },
    ];
    const inst = renderPanel(gates);
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("lint");
    expect(frame).toContain("tests");
    expect(frame).toContain("security");
    inst.unmount();
  });
});
