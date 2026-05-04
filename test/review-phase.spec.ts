import { describe, expect, test } from "bun:test";
import type { GhResult } from "../.claude/phases/gh";
import {
  REVIEW_ROUND_CAP,
  type ReviewDeps,
  type ReviewState,
  type ReviewWork,
  runReview,
  scanReviewComments,
} from "../.claude/phases/review-fn";

function ok(stdout = ""): GhResult {
  return { stdout, stderr: "", exitCode: 0 };
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
    gh: async () => ok(""),
    findModelInSprintPlan: () => null,
    ...overrides,
  };
}

// ── scanReviewComments ──

describe("scanReviewComments — parsing", () => {
  test("no sticky comment → found: false", async () => {
    const result = await scanReviewComments(100, {
      gh: async () => ok("some other comment\n\nanother comment"),
    });
    expect(result).toEqual({ found: false, hasBlockers: false, summary: "no sticky comment yet" });
  });

  test("sticky comment with no blockers → found: true, hasBlockers: false", async () => {
    // Realistic format: blank line between header and body (as gh pr view --comments produces)
    const comment = "## Adversarial Review\n\n✅ All good\n✅ Looks clean";
    const result = await scanReviewComments(100, {
      gh: async () => ok(comment),
    });
    expect(result).toEqual({ found: true, hasBlockers: false, summary: "all clear" });
  });

  test("sticky comment with 🔴 → hasBlockers: true", async () => {
    // Realistic format: blank line between header and emoji (real gh output format)
    const comment = "## Adversarial Review\n\n🔴 Critical issue found";
    const result = await scanReviewComments(100, {
      gh: async () => ok(comment),
    });
    expect(result).toMatchObject({ found: true, hasBlockers: true });
  });

  test("sticky comment with 🟡 → hasBlockers: true", async () => {
    // Realistic format: blank line between header and emoji
    const comment = "## Adversarial Review\n\n🟡 Warning: edge case missed";
    const result = await scanReviewComments(100, {
      gh: async () => ok(comment),
    });
    expect(result).toMatchObject({ found: true, hasBlockers: true });
  });

  test("realistic gh output: blank-line-separated header and emoji content", async () => {
    // Mirrors real 'gh pr view --json comments -q .comments[].body' output where
    // paragraphs within a comment are separated by blank lines. The header block
    // and the 🔴 items are in different split-chunks, so a naive split(/\n{2,}/)
    // approach (the old code) would return hasBlockers: false — this test documents
    // that the fix (lastIndexOf) handles it correctly.
    const body = "## Adversarial Review\n\n🔴 Missing null check in foo.ts line 42\n\n🟡 Consider extracting helper";
    const result = await scanReviewComments(100, {
      gh: async () => ok(body),
    });
    expect(result).toMatchObject({ found: true, hasBlockers: true });
  });

  test("gh call fails → found: false with error summary", async () => {
    const result = await scanReviewComments(100, {
      gh: async () => ({ stdout: "", stderr: "not found", exitCode: 1 }),
    });
    expect(result).toEqual({ found: false, hasBlockers: false, summary: "gh pr view failed" });
  });

  test("picks most recent sticky comment (lastIndexOf)", async () => {
    // Two adversarial review comments in output; the last one (most recent) is clean.
    // Realistic format with blank lines between header and body paragraphs.
    const body = "## Adversarial Review\n\n🔴 Old blocker\n\n## Adversarial Review\n\n✅ All resolved";
    const result = await scanReviewComments(100, {
      gh: async () => ok(body),
    });
    expect(result).toMatchObject({ found: true, hasBlockers: false });
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
    if (result.action === "spawn") {
      expect(result.model).toBe("sonnet");
    }
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
    if (result.action === "spawn") {
      expect(result.model).toBe("opus");
    }
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
    if (result.action === "spawn") {
      expect(result.model).toBe("opus");
    }
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
    if (result.action === "spawn") {
      expect(result.model).toBe("sonnet");
    }
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
    expect(typeof writes.review_session_id).toBe("string");
    expect(String(writes.review_session_id)).toMatch(/^pending:/);
  });
});

// ── runReview — re-entry (session set) ──

describe("runReview — wait path", () => {
  test("session set, no sticky comment → wait", async () => {
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      makeState({ review_session_id: "sess_123", review_round: 1 }),
      makeDeps({ gh: async () => ok("just some comment") }),
      "__none__",
    );
    expect(result.action).toBe("wait");
  });

  test("wait result includes stored model", async () => {
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      makeState({ review_session_id: "sess_123", review_round: 1, review_model: "opus" }),
      makeDeps({ gh: async () => ok("comment without adversarial review") }),
      "__none__",
    );
    expect(result.action).toBe("wait");
    if (result.action === "wait") {
      expect(result.model).toBe("opus");
    }
  });
});

describe("runReview — goto qa (clean review)", () => {
  test("sticky comment with no blockers → goto qa", async () => {
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      makeState({ review_session_id: "sess_123", review_round: 1 }),
      makeDeps({ gh: async () => ok("## Adversarial Review\n\n✅ All good") }),
      "__none__",
    );
    expect(result).toMatchObject({ action: "goto", target: "qa" });
  });
});

describe("runReview — goto repair (blockers present)", () => {
  test("blockers below cap → goto repair", async () => {
    const state = makeState({ review_session_id: "sess_123", review_round: 1 });
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      state,
      makeDeps({ gh: async () => ok("## Adversarial Review\n\n🔴 Critical issue") }),
      "__none__",
    );
    expect(result).toMatchObject({ action: "goto", target: "repair" });
  });

  test("round cap reached with blockers → goto qa instead of repair", async () => {
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      makeState({ review_session_id: "sess_123", review_round: REVIEW_ROUND_CAP }),
      makeDeps({ gh: async () => ok("## Adversarial Review\n\n🔴 Still failing") }),
      "__none__",
    );
    expect(result).toMatchObject({ action: "goto", target: "qa" });
    if (result.action === "goto") {
      expect(result.reason).toContain("round cap");
    }
  });

  test("blockers below cap increments review_round in state", async () => {
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
      makeDeps({ gh: async () => ok("## Adversarial Review\n\n🔴 Issue") }),
      "__none__",
    );
    expect(writes.review_round).toBe(2);
    expect(writes.previous_phase).toBe("review");
  });
});
