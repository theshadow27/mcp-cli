import { describe, expect, test } from "bun:test";
import {
  REVIEW_ROUND_CAP,
  type ReviewDeps,
  type ReviewState,
  type ReviewWork,
  readReviewLabels,
  runReview,
} from "./review-fn";

function makeWork(overrides: Partial<ReviewWork> = {}): ReviewWork {
  return { id: "wi-1", prNumber: 20, branch: "feat/20", issueNumber: 20, ...overrides };
}

function makeState(initial: Record<string, unknown> = {}): ReviewState {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    async get<T>(key: string) {
      return store.get(key) as T | undefined;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}

/** gh() stub that returns the given label names for the `pr:labels` op. */
function labelsGh(labels: string[], exitCode = 0): ReviewDeps["gh"] {
  return async (op) => {
    if (op.op === "pr:labels") {
      return { stdout: exitCode === 0 ? labels.join("\n") : "", stderr: "", exitCode };
    }
    return { stdout: "", stderr: `unsupported gh op: ${op.op}`, exitCode: 1 };
  };
}

function makeDeps(overrides: Partial<ReviewDeps> = {}): ReviewDeps {
  return {
    gh: labelsGh([]),
    async prEdit(_prNumber, _flags) {
      /* no-op */
    },
    findModelInSprintPlan(_issueNumber, _repoRoot) {
      return null;
    },
    ...overrides,
  };
}

describe("readReviewLabels", () => {
  test("returns both false when gh exits non-zero", async () => {
    const deps = makeDeps({ gh: labelsGh(["review:pass"], 1) });
    expect(await readReviewLabels(20, deps)).toEqual({ hasPass: false, hasChanges: false });
  });

  test("returns hasPass=true when review:pass label present", async () => {
    const deps = makeDeps({ gh: labelsGh(["bug", "review:pass"]) });
    expect(await readReviewLabels(20, deps)).toEqual({ hasPass: true, hasChanges: false });
  });

  test("returns hasChanges=true when review:changes label present", async () => {
    const deps = makeDeps({ gh: labelsGh(["review:changes"]) });
    expect(await readReviewLabels(20, deps)).toEqual({ hasPass: false, hasChanges: true });
  });

  test("returns both true when both labels present", async () => {
    const deps = makeDeps({ gh: labelsGh(["review:pass", "review:changes"]) });
    expect(await readReviewLabels(20, deps)).toEqual({ hasPass: true, hasChanges: true });
  });

  test("returns both false when neither verdict label present", async () => {
    const deps = makeDeps({ gh: labelsGh(["bug", "enhancement"]) });
    expect(await readReviewLabels(20, deps)).toEqual({ hasPass: false, hasChanges: false });
  });

  test("trims whitespace around label names", async () => {
    const deps = makeDeps({
      gh: async () => ({ stdout: " review:pass \n bug \n", stderr: "", exitCode: 0 }),
    });
    expect(await readReviewLabels(20, deps)).toEqual({ hasPass: true, hasChanges: false });
  });

  test("consults only the label op, never comment prose (label-only control signal)", async () => {
    // Even if a comment body echoed "review:pass", readReviewLabels asks pr:labels only.
    const deps = makeDeps({ gh: labelsGh([]) });
    expect(await readReviewLabels(20, deps)).toEqual({ hasPass: false, hasChanges: false });
  });
});

describe("runReview — no session yet", () => {
  test("returns spawn action", async () => {
    const state = makeState();
    const result = await runReview({ provider: "claude" }, makeWork(), state, makeDeps(), "/repo");
    expect(result.action).toBe("spawn");
  });

  test("defaults to sonnet when sprint plan has no entry", async () => {
    const state = makeState();
    const result = await runReview({ provider: "claude" }, makeWork(), state, makeDeps(), "/repo");
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") expect(result.model).toBe("sonnet");
  });

  test("respects sprint plan model when found", async () => {
    const state = makeState();
    const deps = makeDeps({ findModelInSprintPlan: () => "opus" });
    const result = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") expect(result.model).toBe("opus");
  });

  test("uses input.model when provided, overriding sprint plan", async () => {
    const state = makeState();
    const deps = makeDeps({ findModelInSprintPlan: () => "sonnet" });
    const result = await runReview({ provider: "claude", model: "opus" }, makeWork(), state, deps, "/repo");
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") expect(result.model).toBe("opus");
  });

  test("skips sprint plan lookup when issueNumber is null", async () => {
    const state = makeState();
    let called = false;
    const deps = makeDeps({
      findModelInSprintPlan() {
        called = true;
        return "opus";
      },
    });
    await runReview({ provider: "claude" }, makeWork({ issueNumber: null }), state, deps, "/repo");
    expect(called).toBe(false);
  });

  test("sets review_session_id as pending in state", async () => {
    const state = makeState();
    await runReview({ provider: "claude" }, makeWork(), state, makeDeps(), "/repo");
    const id = await state.get<string>("review_session_id");
    expect(id).toMatch(/^pending:/);
  });

  test("uses acp spawn command for acp: provider", async () => {
    const state = makeState();
    const result = await runReview({ provider: "acp:reviewer" }, makeWork(), state, makeDeps(), "/repo");
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") {
      expect(result.command).toContain("acp");
      expect(result.command).toContain("--agent");
      expect(result.command).toContain("reviewer");
    }
  });
});

describe("runReview — session exists", () => {
  test("returns wait when no verdict label set yet", async () => {
    const state = makeState({ review_session_id: "abc", review_round: 1 });
    const deps = makeDeps({ gh: labelsGh(["bug"]) });
    const result = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(result.action).toBe("wait");
    if (result.action === "wait") expect(result.reason).toMatch(/label not set/i);
  });

  test("returns goto qa when review:pass label is set", async () => {
    const state = makeState({ review_session_id: "abc", review_round: 1 });
    const deps = makeDeps({ gh: labelsGh(["review:pass"]) });
    const result = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(result.action).toBe("goto");
    if (result.action === "goto") expect(result.target).toBe("qa");
  });

  test("removes review:changes when both labels present (pass wins)", async () => {
    const state = makeState({ review_session_id: "abc", review_round: 1 });
    const removed: string[] = [];
    const deps = makeDeps({
      gh: labelsGh(["review:pass", "review:changes"]),
      async prEdit(_prNumber, flags) {
        for (let i = 0; i < flags.length; i += 2) {
          if (flags[i] === "--remove-label") removed.push(flags[i + 1]);
        }
      },
    });
    const result = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(result.action).toBe("goto");
    if (result.action === "goto") expect(result.target).toBe("qa");
    expect(removed).toContain("review:changes");
  });

  test("returns goto repair when review:changes and round < cap", async () => {
    const state = makeState({ review_session_id: "abc", review_round: 1 });
    const deps = makeDeps({ gh: labelsGh(["review:changes"]) });
    const result = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(result.action).toBe("goto");
    if (result.action === "goto") expect(result.target).toBe("repair");
  });

  test("returns goto qa when round cap reached even with review:changes", async () => {
    const state = makeState({ review_session_id: "abc", review_round: REVIEW_ROUND_CAP });
    const deps = makeDeps({ gh: labelsGh(["review:changes"]) });
    const result = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(result.action).toBe("goto");
    if (result.action === "goto") {
      expect(result.target).toBe("qa");
      expect(result.reason).toMatch(/cap/i);
    }
  });

  test("increments review_round in state when going to repair", async () => {
    const state = makeState({ review_session_id: "abc", review_round: 1 });
    const deps = makeDeps({ gh: labelsGh(["review:changes"]) });
    await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(await state.get<number>("review_round")).toBe(2);
  });

  test("sets previous_phase to review when going to repair", async () => {
    const state = makeState({ review_session_id: "abc", review_round: 1 });
    const deps = makeDeps({ gh: labelsGh(["review:changes"]) });
    await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(await state.get<string>("previous_phase")).toBe("review");
  });
});
