import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { testOptions } from "../../../test/test-options";
import {
  clearSprintState,
  createIssueState,
  createSprintState,
  readSprintState,
  updateIssuePhase,
  writeSprintState,
} from "./sprint-state";
import type { SprintState } from "./sprint-state";

function findIssue(state: SprintState, num: number) {
  const found = state.issues.find((i) => i.issue === num);
  if (!found) throw new Error(`Test bug: issue #${num} not found`);
  return found;
}

function makeSampleState(): SprintState {
  return createSprintState(26, "Stability cleanup", [
    createIssueState(1109, "Worktree pollution", 1, { scrutiny: "medium", provider: "claude" }),
    createIssueState(1108, "approve/deny wiring", 1, { scrutiny: "low" }),
    createIssueState(968, "Sprint pause/resume", 2),
  ]);
}

describe("createIssueState", () => {
  test("creates issue with defaults", () => {
    const issue = createIssueState(42, "Fix bug", 1);
    expect(issue).toEqual({
      issue: 42,
      title: "Fix bug",
      phase: "queued",
      scrutiny: null,
      batch: 1,
      provider: null,
      sessionId: null,
      worktree: null,
      prNumber: null,
      cost: 0,
      startedAt: null,
      completedAt: null,
    });
  });

  test("accepts optional scrutiny and provider", () => {
    const issue = createIssueState(42, "Fix bug", 2, { scrutiny: "high", provider: "codex" });
    expect(issue.scrutiny).toBe("high");
    expect(issue.provider).toBe("codex");
  });
});

describe("createSprintState", () => {
  test("creates sprint with running status", () => {
    const state = makeSampleState();
    expect(state.version).toBe(1);
    expect(state.sprint).toBe(26);
    expect(state.status).toBe("running");
    expect(state.issues).toHaveLength(3);
    expect(state.pausedAt).toBeNull();
    expect(state.completedAt).toBeNull();
    expect(state.quota).toBeNull();
  });
});

describe("updateIssuePhase", () => {
  test("transitions phase and sets startedAt on first move from queued", () => {
    const state = makeSampleState();
    const updated = updateIssuePhase(state, 1109, "implementing", {
      sessionId: "sess-abc",
      worktree: "claude-1109",
    });

    const issue = findIssue(updated, 1109);
    expect(issue.phase).toBe("implementing");
    expect(issue.sessionId).toBe("sess-abc");
    expect(issue.worktree).toBe("claude-1109");
    expect(issue.startedAt).not.toBeNull();
    expect(issue.completedAt).toBeNull();
  });

  test("sets completedAt on terminal phase (merged)", () => {
    let state = makeSampleState();
    state = updateIssuePhase(state, 1108, "implementing");
    state = updateIssuePhase(state, 1108, "merged", { prNumber: 1200, cost: 3.5 });

    const issue = findIssue(state, 1108);
    expect(issue.phase).toBe("merged");
    expect(issue.completedAt).not.toBeNull();
    expect(issue.prNumber).toBe(1200);
    expect(issue.cost).toBe(3.5);
  });

  test("sets completedAt on terminal phase (dropped)", () => {
    const state = makeSampleState();
    const updated = updateIssuePhase(state, 968, "dropped");

    const issue = findIssue(updated, 968);
    expect(issue.phase).toBe("dropped");
    expect(issue.completedAt).not.toBeNull();
  });

  test("does not mutate original state", () => {
    const state = makeSampleState();
    const original1109Phase = state.issues[0].phase;
    updateIssuePhase(state, 1109, "implementing");
    expect(state.issues[0].phase).toBe(original1109Phase);
  });

  test("throws for unknown issue", () => {
    const state = makeSampleState();
    expect(() => updateIssuePhase(state, 9999, "implementing")).toThrow("Issue #9999 not found");
  });

  test("preserves startedAt on subsequent transitions", () => {
    let state = makeSampleState();
    state = updateIssuePhase(state, 1109, "implementing");
    const startedAt = findIssue(state, 1109).startedAt;

    state = updateIssuePhase(state, 1109, "triaging");
    expect(findIssue(state, 1109).startedAt).toBe(startedAt);
  });
});

describe("readSprintState / writeSprintState", () => {
  test("returns null when file is missing", () => {
    using _opts = testOptions();
    expect(readSprintState()).toBeNull();
  });

  test("returns null on malformed JSON", () => {
    using _opts = testOptions({ files: { "sprint-state.json": "not json{{{" } });
    expect(readSprintState()).toBeNull();
  });

  test("returns null when version is not 1", () => {
    using _opts = testOptions({ files: { "sprint-state.json": { version: 2 } } });
    expect(readSprintState()).toBeNull();
  });

  test("roundtrips sprint state through write/read", () => {
    using _opts = testOptions();
    const state = makeSampleState();

    writeSprintState(state);
    const loaded = readSprintState();

    expect(loaded).not.toBeNull();
    expect(loaded?.sprint).toBe(26);
    expect(loaded?.goal).toBe("Stability cleanup");
    expect(loaded?.issues).toHaveLength(3);
    expect(loaded?.issues[0].issue).toBe(1109);
    expect(loaded?.issues[0].scrutiny).toBe("medium");
    expect(loaded?.issues[0].provider).toBe("claude");
  });

  test("writes JSON with trailing newline", () => {
    using opts = testOptions();
    writeSprintState(makeSampleState());
    const raw = readFileSync(opts.SPRINT_STATE_PATH, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("supports custom path", () => {
    using opts = testOptions();
    const customPath = `${opts.dir}/custom-sprint.json`;
    const state = makeSampleState();

    writeSprintState(state, customPath);
    const loaded = readSprintState(customPath);

    expect(loaded).not.toBeNull();
    expect(loaded?.sprint).toBe(26);
  });
});

describe("clearSprintState", () => {
  test("removes existing state file", () => {
    using _opts = testOptions();
    writeSprintState(makeSampleState());
    expect(readSprintState()).not.toBeNull();

    clearSprintState();
    expect(readSprintState()).toBeNull();
  });

  test("no-op when file does not exist", () => {
    using _opts = testOptions();
    expect(() => clearSprintState()).not.toThrow();
  });
});
