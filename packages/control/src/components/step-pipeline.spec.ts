import { describe, expect, it } from "bun:test";
import type { PlanStep } from "@mcp-cli/core";
import { render } from "ink-testing-library";
import React from "react";
import { StepPipeline, statusIndicator } from "./step-pipeline";

function makeStep(overrides: Partial<PlanStep> & { id: string }): PlanStep {
  return {
    name: `Step ${overrides.id}`,
    status: "pending",
    ...overrides,
  };
}

describe("statusIndicator", () => {
  it("returns gray circle for pending", () => {
    expect(statusIndicator("pending")).toEqual({ symbol: "○", color: "gray" });
  });

  it("returns blue filled circle for active", () => {
    expect(statusIndicator("active")).toEqual({ symbol: "●", color: "blue" });
  });

  it("returns yellow for gated", () => {
    expect(statusIndicator("gated")).toEqual({ symbol: "◉", color: "yellow" });
  });

  it("returns green check for complete", () => {
    expect(statusIndicator("complete")).toEqual({ symbol: "✓", color: "green" });
  });

  it("returns red x for aborted", () => {
    expect(statusIndicator("aborted")).toEqual({ symbol: "✗", color: "red" });
  });

  it("returns red x for failed", () => {
    expect(statusIndicator("failed")).toEqual({ symbol: "✗", color: "red" });
  });

  it("returns gray question mark for unknown status", () => {
    expect(statusIndicator("some-future-status")).toEqual({ symbol: "?", color: "gray" });
  });
});

describe("StepPipeline", () => {
  it("shows no-steps message when empty", () => {
    const { lastFrame } = render(React.createElement(StepPipeline, { steps: [], selectedStep: 0 }));
    expect(lastFrame()).toContain("(no steps)");
  });

  it("renders step names", () => {
    const steps = [
      makeStep({ id: "s1", name: "Build", status: "complete" }),
      makeStep({ id: "s2", name: "Test", status: "active" }),
      makeStep({ id: "s3", name: "Deploy", status: "pending" }),
    ];
    const { lastFrame } = render(React.createElement(StepPipeline, { steps, selectedStep: 1 }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Build");
    expect(frame).toContain("Test");
    expect(frame).toContain("Deploy");
  });

  it("renders connectors between steps", () => {
    const steps = [
      makeStep({ id: "s1", name: "A", status: "complete" }),
      makeStep({ id: "s2", name: "B", status: "pending" }),
    ];
    const { lastFrame } = render(React.createElement(StepPipeline, { steps, selectedStep: 0 }));
    expect(lastFrame()).toContain("→");
  });

  it("renders status indicators", () => {
    const steps = [
      makeStep({ id: "s1", name: "Done", status: "complete" }),
      makeStep({ id: "s2", name: "Running", status: "active" }),
    ];
    const { lastFrame } = render(React.createElement(StepPipeline, { steps, selectedStep: 0 }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓");
    expect(frame).toContain("●");
  });
});
