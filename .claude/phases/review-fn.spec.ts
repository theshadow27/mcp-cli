import { describe, expect, test } from "bun:test";
import type { GhLabelEvent } from "./phase-types";
import {
  REVIEW_ROUND_CAP,
  type ReviewDeps,
  type ReviewState,
  type ReviewWork,
  readReviewLabels,
  runReview,
} from "./review-fn";

const DEFAULT_SPAWNED_AT = new Date("2026-06-09T10:00:00Z").getTime();
const DEFAULT_HEAD_DATE = "2026-06-09T09:50:00Z";
const DEFAULT_EVENT_TIME = "2026-06-09T10:05:00Z";
const DEFAULT_AUTHOR = "bot-user";

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
  authorExitCode?: number;
  headDateExitCode?: number;
}

function makeGh(opts: GhStubOpts = {}): ReviewDeps["gh"] {
  const labels = opts.labels ?? [];
  const events = opts.labelEvents ?? validEventsFor(labels);
  return async (op) => {
    if (op.op === "pr:labels") {
      return { stdout: (opts.labelsExitCode ?? 0) === 0 ? labels.join("\n") : "", stderr: "", exitCode: opts.labelsExitCode ?? 0 };
    }
    if (op.op === "pr:label-events") {
      if ((opts.eventsExitCode ?? 0) !== 0) return { stdout: "", stderr: "events fetch error", exitCode: opts.eventsExitCode ?? 1 };
      return { stdout: JSON.stringify(events), stderr: "", exitCode: 0 };
    }
    if (op.op === "pr:author") {
      if ((opts.authorExitCode ?? 0) !== 0) return { stdout: "", stderr: "author fetch error", exitCode: opts.authorExitCode ?? 1 };
      return { stdout: opts.author ?? DEFAULT_AUTHOR, stderr: "", exitCode: 0 };
    }
    if (op.op === "pr:head-date") {
      if ((opts.headDateExitCode ?? 0) !== 0) return { stdout: "", stderr: "head-date fetch error", exitCode: opts.headDateExitCode ?? 1 };
      return { stdout: opts.headDate ?? DEFAULT_HEAD_DATE, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: `unsupported gh op: ${op.op}`, exitCode: 1 };
  };
}

function makeDeps(overrides: Partial<ReviewDeps> = {}): ReviewDeps {
  return {
    gh: makeGh(),
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
    const deps = makeDeps({ gh: makeGh({ labels: ["review:pass"], labelsExitCode: 1 }) });
    const result = await readReviewLabels(20, deps, DEFAULT_SPAWNED_AT);
    expect(result).toMatchObject({ hasPass: false, hasChanges: false });
  });

  test("returns hasPass=true when review:pass label present and valid", async () => {
    const deps = makeDeps({ gh: makeGh({ labels: ["bug", "review:pass"] }) });
    const result = await readReviewLabels(20, deps, DEFAULT_SPAWNED_AT);
    expect(result).toMatchObject({ hasPass: true, hasChanges: false });
  });

  test("returns hasChanges=true when review:changes label present and valid", async () => {
    const deps = makeDeps({ gh: makeGh({ labels: ["review:changes"] }) });
    const result = await readReviewLabels(20, deps, DEFAULT_SPAWNED_AT);
    expect(result).toMatchObject({ hasPass: false, hasChanges: true });
  });

  test("returns both true when both labels present and valid", async () => {
    const deps = makeDeps({ gh: makeGh({ labels: ["review:pass", "review:changes"] }) });
    const result = await readReviewLabels(20, deps, DEFAULT_SPAWNED_AT);
    expect(result).toMatchObject({ hasPass: true, hasChanges: true });
  });

  test("returns both false when neither verdict label present", async () => {
    const deps = makeDeps({ gh: makeGh({ labels: ["bug", "enhancement"] }) });
    const result = await readReviewLabels(20, deps, DEFAULT_SPAWNED_AT);
    expect(result).toMatchObject({ hasPass: false, hasChanges: false });
  });

  test("trims whitespace around label names", async () => {
    const deps = makeDeps({
      gh: async (op) => {
        if (op.op === "pr:labels") return { stdout: " review:pass \n bug \n", stderr: "", exitCode: 0 };
        if (op.op === "pr:label-events") return { stdout: JSON.stringify(validEventsFor(["review:pass"])), stderr: "", exitCode: 0 };
        if (op.op === "pr:author") return { stdout: DEFAULT_AUTHOR, stderr: "", exitCode: 0 };
        if (op.op === "pr:head-date") return { stdout: DEFAULT_HEAD_DATE, stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    });
    const result = await readReviewLabels(20, deps, DEFAULT_SPAWNED_AT);
    expect(result).toMatchObject({ hasPass: true, hasChanges: false });
  });

  test("consults only the label op, never comment prose (label-only control signal)", async () => {
    const deps = makeDeps({ gh: makeGh({ labels: [] }) });
    const result = await readReviewLabels(20, deps, DEFAULT_SPAWNED_AT);
    expect(result).toMatchObject({ hasPass: false, hasChanges: false });
  });
});

describe("readReviewLabels — verdict validation (#2652)", () => {
  test("fail closed: label-events fetch failure rejects all verdicts", async () => {
    const deps = makeDeps({ gh: makeGh({ labels: ["review:pass"], eventsExitCode: 1 }) });
    const result = await readReviewLabels(20, deps, DEFAULT_SPAWNED_AT);
    expect(result.hasPass).toBe(false);
    expect(result.rejections.length).toBeGreaterThan(0);
    expect(result.rejections[0]).toMatch(/fail closed/);
  });

  test("fail closed: author fetch failure rejects all verdicts", async () => {
    const deps = makeDeps({ gh: makeGh({ labels: ["review:pass"], authorExitCode: 1 }) });
    const result = await readReviewLabels(20, deps, DEFAULT_SPAWNED_AT);
    expect(result.hasPass).toBe(false);
    expect(result.rejections[0]).toMatch(/fail closed/);
  });

  test("fail closed: head-date fetch failure rejects all verdicts", async () => {
    const deps = makeDeps({ gh: makeGh({ labels: ["review:pass"], headDateExitCode: 1 }) });
    const result = await readReviewLabels(20, deps, DEFAULT_SPAWNED_AT);
    expect(result.hasPass).toBe(false);
    expect(result.rejections[0]).toMatch(/fail closed/);
  });

  test("fail closed: unparseable events JSON rejects all verdicts", async () => {
    const deps = makeDeps({
      gh: async (op) => {
        if (op.op === "pr:labels") return { stdout: "review:pass", stderr: "", exitCode: 0 };
        if (op.op === "pr:label-events") return { stdout: "not-json!", stderr: "", exitCode: 0 };
        if (op.op === "pr:author") return { stdout: DEFAULT_AUTHOR, stderr: "", exitCode: 0 };
        if (op.op === "pr:head-date") return { stdout: DEFAULT_HEAD_DATE, stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    });
    const result = await readReviewLabels(20, deps, DEFAULT_SPAWNED_AT);
    expect(result.hasPass).toBe(false);
    expect(result.rejections[0]).toMatch(/unparseable/);
  });

  test("fail closed: non-array label events rejects all verdicts", async () => {
    const deps = makeDeps({
      gh: async (op) => {
        if (op.op === "pr:labels") return { stdout: "review:pass", stderr: "", exitCode: 0 };
        if (op.op === "pr:label-events") return { stdout: "{\"foo\":1}", stderr: "", exitCode: 0 };
        if (op.op === "pr:author") return { stdout: DEFAULT_AUTHOR, stderr: "", exitCode: 0 };
        if (op.op === "pr:head-date") return { stdout: DEFAULT_HEAD_DATE, stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    });
    const result = await readReviewLabels(20, deps, DEFAULT_SPAWNED_AT);
    expect(result.hasPass).toBe(false);
    expect(result.rejections.length).toBeGreaterThan(0);
    expect(result.rejections[0]).toMatch(/label-events not an array/);
  })
  test("rejects stale label predating session spawn (guard b)", async () => {
    const staleEvent: GhLabelEvent = { actor: DEFAULT_AUTHOR, label: "review:pass", created_at: "2026-06-09T09:55:00Z" };
    const deps = makeDeps({ gh: makeGh({ labels: ["review:pass"], labelEvents: [staleEvent] }) });
    const result = await readReviewLabels(20, deps, DEFAULT_SPAWNED_AT);
    expect(result.hasPass).toBe(false);
    expect(result.rejections[0]).toMatch(/stale verdict/);
  });

  test("rejects label predating head commit (guard c)", async () => {
    const event: GhLabelEvent = { actor: DEFAULT_AUTHOR, label: "review:pass", created_at: "2026-06-09T10:05:00Z" };
    const deps = makeDeps({ gh: makeGh({ labels: ["review:pass"], labelEvents: [event], headDate: "2026-06-09T10:10:00Z" }) });
    const result = await readReviewLabels(20, deps, DEFAULT_SPAWNED_AT);
    expect(result.hasPass).toBe(false);
    expect(result.rejections[0]).toMatch(/verdict on stale code/);
  });

  test("does not fetch events when no verdict label is present", async () => {
    let eventsFetched = false;
    const deps = makeDeps({
      gh: async (op) => {
        if (op.op === "pr:labels") return { stdout: "bug\nenhancement", stderr: "", exitCode: 0 };
        if (op.op === "pr:label-events") { eventsFetched = true; return { stdout: "[]", stderr: "", exitCode: 0 }; }
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    });
    await readReviewLabels(20, deps, DEFAULT_SPAWNED_AT);
    expect(eventsFetched).toBe(false);
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

  test("stores review_spawned_at in state", async () => {
    const state = makeState();
    await runReview({ provider: "claude" }, makeWork(), state, makeDeps(), "/repo");
    const spawnedAt = await state.get<number>("review_spawned_at");
    expect(spawnedAt).toBeGreaterThan(0);
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
    const state = makeState({ review_session_id: "abc", review_round: 1, review_spawned_at: DEFAULT_SPAWNED_AT });
    const deps = makeDeps({ gh: makeGh({ labels: ["bug"] }) });
    const result = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(result.action).toBe("wait");
    if (result.action === "wait") expect(result.reason).toMatch(/label not set/i);
  });

  test("returns wait when review_spawned_at is missing (fail closed)", async () => {
    const state = makeState({ review_session_id: "abc", review_round: 1 });
    const deps = makeDeps({ gh: makeGh({ labels: ["review:pass"] }) });
    const result = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(result.action).toBe("wait");
    if (result.action === "wait") expect(result.reason).toMatch(/fail closed/);
  });

  test("returns goto qa when review:pass label is set and valid", async () => {
    const state = makeState({ review_session_id: "abc", review_round: 1, review_spawned_at: DEFAULT_SPAWNED_AT });
    const deps = makeDeps({ gh: makeGh({ labels: ["review:pass"] }) });
    const result = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(result.action).toBe("goto");
    if (result.action === "goto") expect(result.target).toBe("qa");
  });

  test("removes review:changes when both labels present (pass wins)", async () => {
    const state = makeState({ review_session_id: "abc", review_round: 1, review_spawned_at: DEFAULT_SPAWNED_AT });
    const removed: string[] = [];
    const deps = makeDeps({
      gh: makeGh({ labels: ["review:pass", "review:changes"] }),
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
    const state = makeState({ review_session_id: "abc", review_round: 1, review_spawned_at: DEFAULT_SPAWNED_AT });
    const deps = makeDeps({ gh: makeGh({ labels: ["review:changes"] }) });
    const result = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(result.action).toBe("goto");
    if (result.action === "goto") expect(result.target).toBe("repair");
  });

  test("returns goto qa when round cap reached even with review:changes", async () => {
    const state = makeState({ review_session_id: "abc", review_round: REVIEW_ROUND_CAP, review_spawned_at: DEFAULT_SPAWNED_AT });
    const deps = makeDeps({ gh: makeGh({ labels: ["review:changes"] }) });
    const result = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(result.action).toBe("goto");
    if (result.action === "goto") {
      expect(result.target).toBe("qa");
      expect(result.reason).toMatch(/cap/i);
    }
  });

  test("increments review_round in state when going to repair", async () => {
    const state = makeState({ review_session_id: "abc", review_round: 1, review_spawned_at: DEFAULT_SPAWNED_AT });
    const deps = makeDeps({ gh: makeGh({ labels: ["review:changes"] }) });
    await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(await state.get<number>("review_round")).toBe(2);
  });

  test("sets previous_phase to review when going to repair", async () => {
    const state = makeState({ review_session_id: "abc", review_round: 1, review_spawned_at: DEFAULT_SPAWNED_AT });
    const deps = makeDeps({ gh: makeGh({ labels: ["review:changes"] }) });
    await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(await state.get<string>("previous_phase")).toBe("review");
  });

  test("clears review:changes on the goto repair (verdict consumed)", async () => {
    const removed: string[] = [];
    const state = makeState({ review_session_id: "abc", review_round: 1, review_spawned_at: DEFAULT_SPAWNED_AT });
    const deps = makeDeps({
      gh: makeGh({ labels: ["review:changes"] }),
      async prEdit(_prNumber, flags) {
        for (let i = 0; i < flags.length; i += 2) {
          if (flags[i] === "--remove-label") removed.push(flags[i + 1]);
        }
      },
    });
    await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(removed).toContain("review:changes");
  });

  test("clears review:changes even when the round cap routes to qa", async () => {
    const removed: string[] = [];
    const state = makeState({ review_session_id: "abc", review_round: REVIEW_ROUND_CAP, review_spawned_at: DEFAULT_SPAWNED_AT });
    const deps = makeDeps({
      gh: makeGh({ labels: ["review:changes"] }),
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

  test("rejects stale review:pass and returns wait with rejection reason", async () => {
    const staleEvent: GhLabelEvent = { actor: DEFAULT_AUTHOR, label: "review:pass", created_at: "2026-06-09T09:55:00Z" };
    const state = makeState({ review_session_id: "abc", review_round: 1, review_spawned_at: DEFAULT_SPAWNED_AT });
    const deps = makeDeps({ gh: makeGh({ labels: ["review:pass"], labelEvents: [staleEvent] }) });
    const result = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(result.action).toBe("wait");
    if (result.action === "wait") expect(result.reason).toMatch(/rejected.*stale/i);
  });
});

// Regression for #2649 mirror-replay drift: review must clear the verdict label it
// consumes, so a re-entry after the repair round waits for a fresh verdict instead of
// replaying the stale one. Drives the real lifecycle over a shared mutable label set.
describe("runReview — lifecycle (#2649)", () => {
  test("stale review:changes does not survive into the round-2 re-entry", async () => {
    const labels = new Set<string>(["review:changes"]);
    const deps = makeDeps({
      gh: async (op) => {
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
      async prEdit(_prNumber, flags) {
        for (let i = 0; i < flags.length; i += 2) {
          if (flags[i] === "--remove-label") labels.delete(flags[i + 1]);
        }
      },
    });
    const state = makeState({ review_session_id: "sess_r1", review_round: 1, review_spawned_at: DEFAULT_SPAWNED_AT });

    const r1 = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(r1).toMatchObject({ action: "goto", target: "repair" });
    expect(labels.has("review:changes")).toBe(false);

    // Repair clears the session sentinel; review spawns a fresh round-2 reviewer.
    await state.set("review_session_id", "sess_r2");

    const r2 = await runReview({ provider: "claude" }, makeWork(), state, deps, "/repo");
    expect(r2.action).toBe("wait");
  });
});
