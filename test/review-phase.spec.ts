import { describe, expect, test } from "bun:test";
import type { GhOp, GhResult } from "../.claude/phases/review-fn";
import {
  REVIEW_ROUND_CAP,
  type ReviewDeps,
  type ReviewState,
  type ReviewWork,
  readReviewLabels,
  runReview,
} from "../.claude/phases/review-fn";

function ok(stdout = ""): GhResult {
  return { stdout, stderr: "", exitCode: 0 };
}

/** gh() stub returning the given label names for the `pr:labels` op. */
function labelsGh(labels: string[], exitCode = 0): ReviewDeps["gh"] {
  return async (op: GhOp) => {
    if (op.op === "pr:labels") {
      return { stdout: exitCode === 0 ? labels.join("\n") : "", stderr: "", exitCode };
    }
    return { stdout: "", stderr: `unsupported gh op: ${op.op}`, exitCode: 1 };
  };
}

function makeWork(overrides: Partial<ReviewWork> = {}): ReviewWork {
  return {
    id: "#42",
    prNumber: 100,
    branch: "feat/issue-42-test",
    issueNumber: 42,
    ...overrides,
  };
}

function makeState(initial: Record<string, unknown> = {}): ReviewState {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: async <T>(key: string) => store.get(key) as T | undefined,
    set: async (key, value) => {
      store.set(key, value);
    },
  };
}

function makeDeps(overrides: Partial<ReviewDeps> = {}): ReviewDeps {
  return {
    gh: labelsGh([]),
    prEdit: async () => {},
    findModelInSprintPlan: () => null,
    ...overrides,
  };
}

// ── readReviewLabels: the typed verdict channel (#2575) ──

describe("readReviewLabels — typed verdict channel", () => {
  test("gh failure → both false", async () => {
    expect(await readReviewLabels(100, { gh: labelsGh(["review:pass"], 1) })).toEqual({
      hasPass: false,
      hasChanges: false,
    });
  });

  test("review:pass present → hasPass", async () => {
    expect(await readReviewLabels(100, { gh: labelsGh(["bug", "review:pass"]) })).toEqual({
      hasPass: true,
      hasChanges: false,
    });
  });

  test("review:changes present → hasChanges", async () => {
    expect(await readReviewLabels(100, { gh: labelsGh(["review:changes"]) })).toEqual({
      hasPass: false,
      hasChanges: true,
    });
  });

  test("both present → both true", async () => {
    expect(await readReviewLabels(100, { gh: labelsGh(["review:pass", "review:changes"]) })).toEqual({
      hasPass: true,
      hasChanges: true,
    });
  });

  test("neither present → both false (no verdict yet)", async () => {
    expect(await readReviewLabels(100, { gh: labelsGh(["bug", "enhancement"]) })).toEqual({
      hasPass: false,
      hasChanges: false,
    });
  });

  test("passes the pr:labels op (never pr:comments — prose is not consulted)", async () => {
    let captured: GhOp | undefined;
    await readReviewLabels(99, {
      gh: async (op) => {
        captured = op;
        return ok("");
      },
    });
    expect(captured).toEqual({ op: "pr:labels", prNumber: 99 });
  });
});

// ── runReview — first entry (no session) ──

describe("runReview — spawn path", () => {
  test("no session → action: spawn", async () => {
    const result = await runReview({ provider: "claude" }, makeWork(), makeState(), makeDeps(), "__none__");
    expect(result.action).toBe("spawn");
  });

  test("default model is sonnet when no plan entry", async () => {
    const result = await runReview({ provider: "claude" }, makeWork(), makeState(), makeDeps(), "__none__");
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") expect(result.model).toBe("sonnet");
  });

  test("explicit model input overrides plan", async () => {
    const result = await runReview(
      { provider: "claude", model: "opus" },
      makeWork(),
      makeState(),
      makeDeps({ findModelInSprintPlan: () => "sonnet" }),
      "/some/root",
    );
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") expect(result.model).toBe("opus");
  });

  test("sprint plan model used when no explicit input", async () => {
    const result = await runReview(
      { provider: "claude" },
      makeWork({ issueNumber: 42 }),
      makeState(),
      makeDeps({ findModelInSprintPlan: () => "opus" }),
      "/some/root",
    );
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") expect(result.model).toBe("opus");
  });

  test("NO_REPO_ROOT skips sprint plan lookup", async () => {
    let planCalled = false;
    const result = await runReview(
      { provider: "claude" },
      makeWork({ issueNumber: 42 }),
      makeState(),
      makeDeps({
        findModelInSprintPlan: () => {
          planCalled = true;
          return "opus";
        },
      }),
      "__none__",
    );
    expect(planCalled).toBe(false);
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") expect(result.model).toBe("sonnet");
  });

  test("command includes correct provider", async () => {
    const result = await runReview({ provider: "claude" }, makeWork(), makeState(), makeDeps(), "__none__");
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") {
      expect(result.command).toContain("mcx");
      expect(result.command).toContain("claude");
      expect(result.command).toContain("spawn");
    }
  });

  test("acp provider builds correct command", async () => {
    const result = await runReview({ provider: "acp:my-agent" }, makeWork(), makeState(), makeDeps(), "__none__");
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") {
      expect(result.command).toEqual(expect.arrayContaining(["mcx", "acp", "spawn", "--agent", "my-agent"]));
    }
  });

  test("prompt includes PR number, branch, and round", async () => {
    const result = await runReview(
      { provider: "claude" },
      makeWork({ prNumber: 42, branch: "feat/foo" }),
      makeState(),
      makeDeps(),
      "__none__",
    );
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") {
      expect(result.prompt).toContain("PR 42");
      expect(result.prompt).toContain("feat/foo");
      expect(result.prompt).toContain("round 1");
    }
  });

  test("writes review_round, review_model, review_session_id to state", async () => {
    const state = makeState();
    const writes: Record<string, unknown> = {};
    const trackingState: ReviewState = {
      get: state.get,
      set: async (key, value) => {
        writes[key] = value;
        await state.set(key, value);
      },
    };
    await runReview({ provider: "claude" }, makeWork(), trackingState, makeDeps(), "__none__");
    expect(writes.review_round).toBe(1);
    expect(writes.review_model).toBe("sonnet");
    expect(String(writes.review_session_id)).toMatch(/^pending:/);
  });
});

// ── runReview — re-entry (session set), driven by verdict label ──

describe("runReview — wait path", () => {
  test("session set, no verdict label → wait", async () => {
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      makeState({ review_session_id: "sess_123", review_round: 1 }),
      makeDeps({ gh: labelsGh(["bug"]) }),
      "__none__",
    );
    expect(result.action).toBe("wait");
  });

  test("wait result includes stored model", async () => {
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      makeState({ review_session_id: "sess_123", review_round: 1, review_model: "opus" }),
      makeDeps({ gh: labelsGh([]) }),
      "__none__",
    );
    expect(result.action).toBe("wait");
    if (result.action === "wait") expect(result.model).toBe("opus");
  });
});

describe("runReview — goto qa (review:pass)", () => {
  test("review:pass label → goto qa", async () => {
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      makeState({ review_session_id: "sess_123", review_round: 1 }),
      makeDeps({ gh: labelsGh(["review:pass"]) }),
      "__none__",
    );
    expect(result).toMatchObject({ action: "goto", target: "qa" });
  });

  test("both labels set → pass wins and stale review:changes is removed", async () => {
    const removed: string[] = [];
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      makeState({ review_session_id: "sess_123", review_round: 1 }),
      makeDeps({
        gh: labelsGh(["review:pass", "review:changes"]),
        prEdit: async (_pr, flags) => {
          for (let i = 0; i < flags.length; i += 2) {
            if (flags[i] === "--remove-label") removed.push(flags[i + 1]);
          }
        },
      }),
      "__none__",
    );
    expect(result).toMatchObject({ action: "goto", target: "qa" });
    expect(removed).toContain("review:changes");
  });
});

describe("runReview — goto repair (review:changes)", () => {
  test("review:changes below cap → goto repair", async () => {
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      makeState({ review_session_id: "sess_123", review_round: 1 }),
      makeDeps({ gh: labelsGh(["review:changes"]) }),
      "__none__",
    );
    expect(result).toMatchObject({ action: "goto", target: "repair" });
  });

  test("round cap reached with review:changes → goto qa instead of repair", async () => {
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      makeState({ review_session_id: "sess_123", review_round: REVIEW_ROUND_CAP }),
      makeDeps({ gh: labelsGh(["review:changes"]) }),
      "__none__",
    );
    expect(result).toMatchObject({ action: "goto", target: "qa" });
    expect(result.action).toBe("goto");
    if (result.action === "goto") expect(result.reason).toContain("cap");
  });

  test("review:changes below cap increments review_round and sets previous_phase", async () => {
    const writes: Record<string, unknown> = {};
    const state = makeState({ review_session_id: "sess_123", review_round: 1 });
    const trackingState: ReviewState = {
      get: state.get,
      set: async (key, value) => {
        writes[key] = value;
        await state.set(key, value);
      },
    };
    await runReview(
      { provider: "claude" },
      makeWork(),
      trackingState,
      makeDeps({ gh: labelsGh(["review:changes"]) }),
      "__none__",
    );
    expect(writes.review_round).toBe(2);
    expect(writes.previous_phase).toBe("review");
  });
});
