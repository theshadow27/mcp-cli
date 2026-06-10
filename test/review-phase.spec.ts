import { describe, expect, test } from "bun:test";
import type { GhLabelEvent } from "../.claude/phases/phase-types";
import type { GhOp, GhResult } from "../.claude/phases/review-fn";
import {
  REVIEW_ROUND_CAP,
  type ReviewDeps,
  type ReviewState,
  type ReviewWork,
  readReviewLabels,
  runReview,
} from "../.claude/phases/review-fn";

const DEFAULT_SPAWNED_AT = new Date("2026-06-09T10:00:00Z").getTime();
const DEFAULT_HEAD_DATE = "2026-06-09T09:50:00Z";
const DEFAULT_EVENT_TIME = "2026-06-09T10:05:00Z";
const DEFAULT_AUTHOR = "bot-user";

function ok(stdout = ""): GhResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function validEventsFor(labels: string[]): GhLabelEvent[] {
  return labels
    .filter((l) => l.startsWith("review:") || l.startsWith("qa:"))
    .map((l) => ({ actor: DEFAULT_AUTHOR, label: l, created_at: DEFAULT_EVENT_TIME }));
}

interface GhStubOpts {
  labels?: string[];
  labelEvents?: GhLabelEvent[];
  author?: string;
  headDate?: string;
  labelsExitCode?: number;
  eventsExitCode?: number;
}

function makeGh(opts: GhStubOpts = {}): ReviewDeps["gh"] {
  const labels = opts.labels ?? [];
  const events = opts.labelEvents ?? validEventsFor(labels);
  return async (op: GhOp) => {
    if (op.op === "pr:labels") {
      return {
        stdout: (opts.labelsExitCode ?? 0) === 0 ? labels.join("\n") : "",
        stderr: "",
        exitCode: opts.labelsExitCode ?? 0,
      };
    }
    if (op.op === "pr:label-events") {
      if ((opts.eventsExitCode ?? 0) !== 0)
        return { stdout: "", stderr: "events error", exitCode: opts.eventsExitCode ?? 1 };
      return { stdout: JSON.stringify(events), stderr: "", exitCode: 0 };
    }
    if (op.op === "pr:author") return { stdout: opts.author ?? DEFAULT_AUTHOR, stderr: "", exitCode: 0 };
    if (op.op === "pr:head-date") return { stdout: opts.headDate ?? DEFAULT_HEAD_DATE, stderr: "", exitCode: 0 };
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
    gh: makeGh(),
    prEdit: async () => {},
    findModelInSprintPlan: () => null,
    ...overrides,
  };
}

// ── readReviewLabels: the typed verdict channel (#2575, hardened #2652) ──

describe("readReviewLabels — typed verdict channel", () => {
  test("gh failure → both false", async () => {
    const result = await readReviewLabels(
      100,
      { gh: makeGh({ labels: ["review:pass"], labelsExitCode: 1 }) },
      DEFAULT_SPAWNED_AT,
    );
    expect(result).toMatchObject({ hasPass: false, hasChanges: false });
  });

  test("review:pass present and valid → hasPass", async () => {
    const result = await readReviewLabels(100, { gh: makeGh({ labels: ["bug", "review:pass"] }) }, DEFAULT_SPAWNED_AT);
    expect(result).toMatchObject({ hasPass: true, hasChanges: false });
  });

  test("review:changes present and valid → hasChanges", async () => {
    const result = await readReviewLabels(100, { gh: makeGh({ labels: ["review:changes"] }) }, DEFAULT_SPAWNED_AT);
    expect(result).toMatchObject({ hasPass: false, hasChanges: true });
  });

  test("both present and valid → both true", async () => {
    const result = await readReviewLabels(
      100,
      { gh: makeGh({ labels: ["review:pass", "review:changes"] }) },
      DEFAULT_SPAWNED_AT,
    );
    expect(result).toMatchObject({ hasPass: true, hasChanges: true });
  });

  test("neither present → both false (no verdict yet)", async () => {
    const result = await readReviewLabels(100, { gh: makeGh({ labels: ["bug", "enhancement"] }) }, DEFAULT_SPAWNED_AT);
    expect(result).toMatchObject({ hasPass: false, hasChanges: false });
  });

  test("passes the pr:labels op (never pr:comments — prose is not consulted)", async () => {
    let captured: GhOp | undefined;
    await readReviewLabels(
      99,
      {
        gh: async (op) => {
          if (!captured) captured = op;
          return ok("");
        },
      },
      DEFAULT_SPAWNED_AT,
    );
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

  test("writes review_round, review_model, review_session_id, review_spawned_at to state", async () => {
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
    expect(writes.review_spawned_at).toBeGreaterThan(0);
  });
});

// ── runReview — re-entry (session set), driven by verdict label ──

describe("runReview — wait path", () => {
  test("session set, no verdict label → wait", async () => {
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      makeState({ review_session_id: "sess_123", review_round: 1, review_spawned_at: DEFAULT_SPAWNED_AT }),
      makeDeps({ gh: makeGh({ labels: ["bug"] }) }),
      "__none__",
    );
    expect(result.action).toBe("wait");
  });

  test("wait result includes stored model", async () => {
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      makeState({
        review_session_id: "sess_123",
        review_round: 1,
        review_model: "opus",
        review_spawned_at: DEFAULT_SPAWNED_AT,
      }),
      makeDeps({ gh: makeGh() }),
      "__none__",
    );
    expect(result.action).toBe("wait");
    if (result.action === "wait") expect(result.model).toBe("opus");
  });

  test("missing review_spawned_at → wait (fail closed)", async () => {
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      makeState({ review_session_id: "sess_123", review_round: 1 }),
      makeDeps({ gh: makeGh({ labels: ["review:pass"] }) }),
      "__none__",
    );
    expect(result.action).toBe("wait");
    if (result.action === "wait") expect(result.reason).toMatch(/fail closed/);
  });
});

describe("runReview — goto qa (review:pass)", () => {
  test("review:pass label → goto qa", async () => {
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      makeState({ review_session_id: "sess_123", review_round: 1, review_spawned_at: DEFAULT_SPAWNED_AT }),
      makeDeps({ gh: makeGh({ labels: ["review:pass"] }) }),
      "__none__",
    );
    expect(result).toMatchObject({ action: "goto", target: "qa" });
  });

  test("both labels set → pass wins and stale review:changes is removed", async () => {
    const removed: string[] = [];
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      makeState({ review_session_id: "sess_123", review_round: 1, review_spawned_at: DEFAULT_SPAWNED_AT }),
      makeDeps({
        gh: makeGh({ labels: ["review:pass", "review:changes"] }),
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
      makeState({ review_session_id: "sess_123", review_round: 1, review_spawned_at: DEFAULT_SPAWNED_AT }),
      makeDeps({ gh: makeGh({ labels: ["review:changes"] }) }),
      "__none__",
    );
    expect(result).toMatchObject({ action: "goto", target: "repair" });
  });

  test("round cap reached with review:changes → goto qa instead of repair", async () => {
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      makeState({
        review_session_id: "sess_123",
        review_round: REVIEW_ROUND_CAP,
        review_spawned_at: DEFAULT_SPAWNED_AT,
      }),
      makeDeps({ gh: makeGh({ labels: ["review:changes"] }) }),
      "__none__",
    );
    expect(result).toMatchObject({ action: "goto", target: "qa" });
    expect(result.action).toBe("goto");
    if (result.action === "goto") expect(result.reason).toContain("cap");
  });

  test("review:changes below cap increments review_round and sets previous_phase", async () => {
    const writes: Record<string, unknown> = {};
    const state = makeState({ review_session_id: "sess_123", review_round: 1, review_spawned_at: DEFAULT_SPAWNED_AT });
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
      makeDeps({ gh: makeGh({ labels: ["review:changes"] }) }),
      "__none__",
    );
    expect(writes.review_round).toBe(2);
    expect(writes.previous_phase).toBe("review");
  });

  test("review:changes is cleared on the goto repair (verdict consumed)", async () => {
    const removed: string[] = [];
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      makeState({ review_session_id: "sess_123", review_round: 1, review_spawned_at: DEFAULT_SPAWNED_AT }),
      makeDeps({
        gh: makeGh({ labels: ["review:changes"] }),
        prEdit: async (_pr, flags) => {
          for (let i = 0; i < flags.length; i += 2) {
            if (flags[i] === "--remove-label") removed.push(flags[i + 1]);
          }
        },
      }),
      "__none__",
    );
    expect(result).toMatchObject({ action: "goto", target: "repair" });
    expect(removed).toContain("review:changes");
  });

  test("review:changes is cleared even when the round cap routes to qa", async () => {
    const removed: string[] = [];
    const result = await runReview(
      { provider: "claude" },
      makeWork(),
      makeState({
        review_session_id: "sess_123",
        review_round: REVIEW_ROUND_CAP,
        review_spawned_at: DEFAULT_SPAWNED_AT,
      }),
      makeDeps({
        gh: makeGh({ labels: ["review:changes"] }),
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

// ── Multi-tick lifecycle: stale verdict must not survive the repair round (#2649) ──
describe("runReview — lifecycle (#2649)", () => {
  test("stale review:changes does not survive into the round-2 re-entry", async () => {
    const labels = new Set<string>(["review:changes"]);
    const deps = makeDeps({
      gh: async (op: GhOp) => {
        if (op.op === "pr:labels") return { stdout: [...labels].join("\n"), stderr: "", exitCode: 0 };
        if (op.op === "pr:label-events") {
          const events = [...labels]
            .filter((l) => l.startsWith("review:"))
            .map((l) => ({ actor: DEFAULT_AUTHOR, label: l, created_at: DEFAULT_EVENT_TIME }));
          return { stdout: JSON.stringify(events), stderr: "", exitCode: 0 };
        }
        if (op.op === "pr:author") return { stdout: DEFAULT_AUTHOR, stderr: "", exitCode: 0 };
        if (op.op === "pr:head-date") return { stdout: DEFAULT_HEAD_DATE, stderr: "", exitCode: 0 };
        return { stdout: "", stderr: `unsupported gh op: ${op.op}`, exitCode: 1 };
      },
      prEdit: async (_pr, flags) => {
        for (let i = 0; i < flags.length; i += 2) {
          if (flags[i] === "--remove-label") labels.delete(flags[i + 1]);
        }
      },
    });
    const state = makeState({ review_session_id: "sess_r1", review_round: 1, review_spawned_at: DEFAULT_SPAWNED_AT });

    const r1 = await runReview({ provider: "claude" }, makeWork(), state, deps, "__none__");
    expect(r1).toMatchObject({ action: "goto", target: "repair" });
    expect(labels.has("review:changes")).toBe(false);
    expect(await state.get<number>("review_round")).toBe(REVIEW_ROUND_CAP);

    await state.set("review_session_id", "sess_r2");

    const r2 = await runReview({ provider: "claude" }, makeWork(), state, deps, "__none__");
    expect(r2.action).toBe("wait");
  });
});
