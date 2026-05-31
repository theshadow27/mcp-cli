import { describe, expect, test } from "bun:test";
import {
  REVIEW_ROUND_CAP,
  type ReviewDeps,
  type ReviewState,
  type ReviewWork,
  scanReviewComments,
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

function makeDeps(overrides: Partial<ReviewDeps> = {}): ReviewDeps {
  return {
    async gh(_args) {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    findModelInSprintPlan(_issueNumber, _repoRoot) {
      return null;
    },
    ...overrides,
  };
}

const STICKY_APPROVED = `## Adversarial Review\n\n✅ **Approved** — no issues found.\n`;
const STICKY_CHANGES = `## Adversarial Review\n\n⚠️ **Changes requested** — see blockers below.\n`;
const STICKY_NAKED_RED = `## Adversarial Review\n\n🔴 Missing error handler\n`;
const STICKY_NAKED_RESOLVED = `## Adversarial Review\n\n🔴 ✅ Fixed in abc123\n`;
const STICKY_NAKED_YELLOW = `## Adversarial Review\n\n🟡 Minor style nit\n`;

describe("scanReviewComments", () => {
  test("returns found=false when gh exits non-zero", async () => {
    const deps = makeDeps({
      async gh() {
        return { stdout: "", stderr: "error", exitCode: 1 };
      },
    });
    const result = await scanReviewComments(20, deps);
    expect(result.found).toBe(false);
    expect(result.hasBlockers).toBe(false);
  });

  test("returns found=false when no sticky comment present", async () => {
    const deps = makeDeps({
      async gh() {
        return { stdout: "Just a regular comment\n", stderr: "", exitCode: 0 };
      },
    });
    const result = await scanReviewComments(20, deps);
    expect(result.found).toBe(false);
    expect(result.hasBlockers).toBe(false);
  });

  test("returns approved when verdict line matches ✅ Approved", async () => {
    const deps = makeDeps({
      async gh() {
        return { stdout: STICKY_APPROVED, stderr: "", exitCode: 0 };
      },
    });
    const result = await scanReviewComments(20, deps);
    expect(result.found).toBe(true);
    expect(result.hasBlockers).toBe(false);
    expect(result.summary).toMatch(/approved/i);
  });

  test("returns changes-requested when verdict line matches ⚠️ Changes requested", async () => {
    const deps = makeDeps({
      async gh() {
        return { stdout: STICKY_CHANGES, stderr: "", exitCode: 0 };
      },
    });
    const result = await scanReviewComments(20, deps);
    expect(result.found).toBe(true);
    expect(result.hasBlockers).toBe(true);
    expect(result.summary).toMatch(/changes requested/i);
  });

  test("classifies naked 🔴 without resolution marker as blocker", async () => {
    const deps = makeDeps({
      async gh() {
        return { stdout: STICKY_NAKED_RED, stderr: "", exitCode: 0 };
      },
    });
    const result = await scanReviewComments(20, deps);
    expect(result.found).toBe(true);
    expect(result.hasBlockers).toBe(true);
  });

  test("ignores 🔴 that has resolution marker on same line", async () => {
    const deps = makeDeps({
      async gh() {
        return { stdout: STICKY_NAKED_RESOLVED, stderr: "", exitCode: 0 };
      },
    });
    const result = await scanReviewComments(20, deps);
    expect(result.found).toBe(true);
    expect(result.hasBlockers).toBe(false);
  });

  test("classifies naked 🟡 without resolution as blocker", async () => {
    const deps = makeDeps({
      async gh() {
        return { stdout: STICKY_NAKED_YELLOW, stderr: "", exitCode: 0 };
      },
    });
    const result = await scanReviewComments(20, deps);
    expect(result.found).toBe(true);
    expect(result.hasBlockers).toBe(true);
  });

  test("uses last sticky comment when multiple are present", async () => {
    // First sticky: changes requested, second sticky: approved — approved wins (it's last)
    const twoStickies =
      `## Adversarial Review\n⚠️ Changes requested\n` +
      `\n` +
      `## Adversarial Review\n✅ Approved — all clear\n`;
    const deps = makeDeps({
      async gh() {
        return { stdout: twoStickies, stderr: "", exitCode: 0 };
      },
    });
    const result = await scanReviewComments(20, deps);
    expect(result.hasBlockers).toBe(false);
  });

  test("returns all clear when sticky has no blockers and no explicit verdict", async () => {
    const noEmoji = `## Adversarial Review\n\nLooks good to me, minor suggestion addressed.\n`;
    const deps = makeDeps({
      async gh() {
        return { stdout: noEmoji, stderr: "", exitCode: 0 };
      },
    });
    const result = await scanReviewComments(20, deps);
    expect(result.found).toBe(true);
    expect(result.hasBlockers).toBe(false);
  });
});

describe("runReview — spawn prompt", () => {
  test("includes resolve step with correct pr number", async () => {
    const state = makeState();
    const result = await runReview({ provider: "claude" }, makeWork({ prNumber: 55 }), state, makeDeps(), "/repo");
    if (result.action === "spawn") {
      expect(result.prompt).toContain("mcx pr comments 55 resolve --all-addressed");
    }
  });

  test("resolve step names the pr number from the work item", async () => {
    const state = makeState();
    const result = await runReview({ provider: "claude" }, makeWork({ prNumber: 99 }), state, makeDeps(), "/repo");
    if (result.action === "spawn") {
      expect(result.prompt).toContain("mcx pr comments 99 resolve --all-addressed");
    }
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
    if (result.action === "spawn") expect(result.model).toBe("sonnet");
  });

  test("respects sprint plan model when found", async () => {
    const state = makeState();
    const deps = makeDeps({ findModelInSprintPlan: () => "opus" });
    const result = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    if (result.action === "spawn") expect(result.model).toBe("opus");
  });

  test("uses input.model when provided, overriding sprint plan", async () => {
    const state = makeState();
    const deps = makeDeps({ findModelInSprintPlan: () => "sonnet" });
    const result = await runReview({ provider: "claude", model: "opus" }, makeWork(), state, deps, "/repo");
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
    if (result.action === "spawn") {
      expect(result.command).toContain("acp");
      expect(result.command).toContain("--agent");
      expect(result.command).toContain("reviewer");
    }
  });
});

describe("runReview — session exists", () => {
  test("returns wait when no sticky comment yet", async () => {
    const state = makeState({ review_session_id: "abc", review_round: 1 });
    const deps = makeDeps({
      async gh() {
        return { stdout: "A regular comment\n", stderr: "", exitCode: 0 };
      },
    });
    const result = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(result.action).toBe("wait");
  });

  test("returns goto qa when review is clean", async () => {
    const state = makeState({ review_session_id: "abc", review_round: 1 });
    const deps = makeDeps({
      async gh() {
        return { stdout: STICKY_APPROVED, stderr: "", exitCode: 0 };
      },
    });
    const result = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(result.action).toBe("goto");
    if (result.action === "goto") expect(result.target).toBe("qa");
  });

  test("returns goto repair when blockers remain and round < cap", async () => {
    const state = makeState({ review_session_id: "abc", review_round: 1 });
    const deps = makeDeps({
      async gh() {
        return { stdout: STICKY_CHANGES, stderr: "", exitCode: 0 };
      },
    });
    const result = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(result.action).toBe("goto");
    if (result.action === "goto") expect(result.target).toBe("repair");
  });

  test("returns goto qa when round cap reached even with blockers", async () => {
    const state = makeState({ review_session_id: "abc", review_round: REVIEW_ROUND_CAP });
    const deps = makeDeps({
      async gh() {
        return { stdout: STICKY_CHANGES, stderr: "", exitCode: 0 };
      },
    });
    const result = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(result.action).toBe("goto");
    if (result.action === "goto") {
      expect(result.target).toBe("qa");
      expect(result.reason).toMatch(/cap/i);
    }
  });

  test("increments review_round in state when going to repair", async () => {
    const state = makeState({ review_session_id: "abc", review_round: 1 });
    const deps = makeDeps({
      async gh() {
        return { stdout: STICKY_CHANGES, stderr: "", exitCode: 0 };
      },
    });
    await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(await state.get<number>("review_round")).toBe(2);
  });
});
