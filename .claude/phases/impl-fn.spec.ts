import { describe, expect, test } from "bun:test";
import { buildImplCommand, buildImplPrompt, detectPrescribedRootCause, resolveImplModel } from "./impl-fn";

describe("buildImplPrompt", () => {
  test("includes the issue number", () => {
    const prompt = buildImplPrompt(42, null);
    expect(prompt).toContain("42");
  });

  test("contains /implement skill invocation", () => {
    expect(buildImplPrompt(42, null)).toMatch(/^\/implement 42/);
  });

  test("omits resolve step when prNumber is null", () => {
    const prompt = buildImplPrompt(42, null);
    expect(prompt).not.toContain("resolve");
  });

  test("includes resolve step when prNumber is provided", () => {
    const prompt = buildImplPrompt(42, 30);
    expect(prompt).toContain("mcx pr comments 30 resolve --all-addressed");
  });

  test("resolve step references the correct pr number", () => {
    expect(buildImplPrompt(10, 99)).toContain("mcx pr comments 99 resolve --all-addressed");
  });

  test("omits the verify-hypothesis mandate by default", () => {
    expect(buildImplPrompt(42, null)).not.toContain("VERIFY-THE-HYPOTHESIS");
  });

  test("appends the verify-hypothesis mandate when flagged", () => {
    const prompt = buildImplPrompt(42, null, { verifyHypothesis: true });
    expect(prompt).toContain("VERIFY-THE-HYPOTHESIS");
    expect(prompt).toContain("Reproduction evidence:");
  });
});

describe("detectPrescribedRootCause", () => {
  test("true when the issue carries the flaky label", () => {
    expect(detectPrescribedRootCause({ labels: ["flaky"], commentBodies: [] })).toBe(true);
  });

  test("true when the issue carries needs-attention", () => {
    expect(detectPrescribedRootCause({ labels: ["needs-attention"], commentBodies: [] })).toBe(true);
  });

  test("true when a comment reads like an investigation writeup", () => {
    expect(detectPrescribedRootCause({ labels: [], commentBodies: ["Investigation: the race is in X"] })).toBe(true);
  });

  test("true on a Root cause: comment (case-insensitive)", () => {
    expect(detectPrescribedRootCause({ labels: [], commentBodies: ["root cause: null deref at foo.ts:12"] })).toBe(true);
  });

  test("false for an ordinary issue with plain comments", () => {
    expect(detectPrescribedRootCause({ labels: ["enhancement"], commentBodies: ["+1", "any update?"] })).toBe(false);
  });
});

describe("resolveImplModel", () => {
  test("explicit input overrides everything", () => {
    const r = resolveImplModel({ inputModel: "sonnet", stateModel: "opus", planModel: "fable", labels: [] });
    expect(r.model).toBe("sonnet");
    expect(r.override).toBeNull();
  });

  test("pre-set work-item state wins over the plan", () => {
    const r = resolveImplModel({ stateModel: "claude-fable-5", planModel: "opus", labels: [] });
    expect(r.model).toBe("claude-fable-5");
    expect(r.override).toBeNull();
  });

  test("uses the sprint-plan model when no input/state is set", () => {
    const r = resolveImplModel({ planModel: "claude-fable-5", labels: [] });
    expect(r.model).toBe("claude-fable-5");
  });

  test("reports an override when the plan model differs from the heuristic", () => {
    // #2665: a fable canary plan row must survive — not be narrowed to opus.
    const r = resolveImplModel({ planModel: "claude-fable-5", labels: [] });
    expect(r.override).toEqual({ planModel: "claude-fable-5", heuristic: "opus" });
  });

  test("no override when the plan model matches the heuristic", () => {
    const r = resolveImplModel({ planModel: "opus", labels: [] });
    expect(r.override).toBeNull();
  });

  test("falls back to the label heuristic when nothing is assigned", () => {
    expect(resolveImplModel({ labels: [] }).model).toBe("opus");
    expect(resolveImplModel({ labels: ["docs-only"] }).model).toBe("sonnet");
    expect(resolveImplModel({ labels: ["flaky"] }).model).toBe("opus");
  });
});

describe("buildImplCommand", () => {
  test("a fable plan row yields a fable spawn command", () => {
    // End-to-end of the #2665 fix: plan says fable → the emitted spawn command
    // carries --model claude-fable-5, not the opus default.
    const { model } = resolveImplModel({ planModel: "claude-fable-5", labels: [] });
    const command = buildImplCommand({
      provider: "claude",
      model,
      supportsWorktree: true,
      prompt: "/implement 2645",
      allowTools: ["Read", "Edit"],
    });
    const modelIdx = command.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(command[modelIdx + 1]).toBe("claude-fable-5");
    expect(command.slice(0, 2)).toEqual(["mcx", "claude"]);
    expect(command).toContain("--worktree");
  });

  test("omits --worktree for providers that do not support it", () => {
    const command = buildImplCommand({
      provider: "gemini",
      model: "opus",
      supportsWorktree: false,
      prompt: "/implement 1",
      allowTools: ["Read"],
    });
    expect(command).not.toContain("--worktree");
    expect(command.slice(0, 3)).toEqual(["mcx", "gemini", "spawn"]);
  });
});
