import { describe, expect, test } from "bun:test";
import type { GhLabelEvent } from "./phase-types";
import {
  QA_FAIL_CAP,
  QA_RESPAWN_CAP,
  QA_STUCK_TICK_CAP,
  type QaDeps,
  type QaState,
  type QaWork,
  readQaLabels,
  runQa,
} from "./qa-fn";

const DEFAULT_SPAWNED_AT = new Date("2026-06-09T10:00:00Z").getTime();
const DEFAULT_HEAD_DATE = "2026-06-09T09:50:00Z";
const DEFAULT_EVENT_TIME = "2026-06-09T10:05:00Z";
const DEFAULT_AUTHOR = "bot-user";

function makeWork(overrides: Partial<QaWork> = {}): QaWork {
  return { id: "wi-1", prNumber: 10, branch: "feat/10", issueNumber: 10, ...overrides };
}

function makeState(initial: Record<string, unknown> = {}): QaState {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    async get<T>(key: string) {
      return store.get(key) as T | undefined;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

function validEventsFor(labels: string[]): GhLabelEvent[] {
  return labels
    .filter((l) => l.startsWith("qa:") || l.startsWith("review:"))
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

function makeGh(opts: GhStubOpts = {}): QaDeps["gh"] {
  const labels = opts.labels ?? [];
  const events = opts.labelEvents ?? validEventsFor(labels);
  return async (op) => {
    if (op.op === "pr:labels") {
      return {
        stdout: (opts.labelsExitCode ?? 0) === 0 ? labels.join("\n") : "",
        stderr: "",
        exitCode: opts.labelsExitCode ?? 0,
      };
    }
    if (op.op === "pr:label-events") {
      if ((opts.eventsExitCode ?? 0) !== 0)
        return { stdout: "", stderr: "events fetch error", exitCode: opts.eventsExitCode ?? 1 };
      return { stdout: JSON.stringify(events), stderr: "", exitCode: 0 };
    }
    if (op.op === "pr:author") {
      if ((opts.authorExitCode ?? 0) !== 0)
        return { stdout: "", stderr: "author fetch error", exitCode: opts.authorExitCode ?? 1 };
      return { stdout: opts.author ?? DEFAULT_AUTHOR, stderr: "", exitCode: 0 };
    }
    if (op.op === "pr:head-date") {
      if ((opts.headDateExitCode ?? 0) !== 0)
        return { stdout: "", stderr: "head-date fetch error", exitCode: opts.headDateExitCode ?? 1 };
      return { stdout: opts.headDate ?? DEFAULT_HEAD_DATE, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: `unsupported gh op: ${op.op}`, exitCode: 1 };
  };
}

function makeDeps(overrides: Partial<QaDeps> = {}): QaDeps {
  return {
    gh: makeGh(),
    async prEdit(_prNumber, _flags) {},
    ...overrides,
  };
}

describe("readQaLabels", () => {
  test("returns hasPass=true when qa:pass label present and valid", async () => {
    const deps = makeDeps({ gh: makeGh({ labels: ["qa:pass", "bug"] }) });
    const result = await readQaLabels(10, deps, DEFAULT_SPAWNED_AT);
    expect(result.hasPass).toBe(true);
    expect(result.hasFail).toBe(false);
  });

  test("returns hasFail=true when qa:fail label present and valid", async () => {
    const deps = makeDeps({ gh: makeGh({ labels: ["qa:fail"] }) });
    const result = await readQaLabels(10, deps, DEFAULT_SPAWNED_AT);
    expect(result.hasPass).toBe(false);
    expect(result.hasFail).toBe(true);
  });

  test("returns both true when both labels present and valid", async () => {
    const deps = makeDeps({ gh: makeGh({ labels: ["qa:pass", "qa:fail"] }) });
    const result = await readQaLabels(10, deps, DEFAULT_SPAWNED_AT);
    expect(result.hasPass).toBe(true);
    expect(result.hasFail).toBe(true);
  });

  test("returns both false when gh exits non-zero", async () => {
    const deps = makeDeps({ gh: makeGh({ labels: ["qa:pass"], labelsExitCode: 1 }) });
    const result = await readQaLabels(10, deps, DEFAULT_SPAWNED_AT);
    expect(result.hasPass).toBe(false);
    expect(result.hasFail).toBe(false);
  });

  test("returns both false when no qa labels present", async () => {
    const deps = makeDeps({ gh: makeGh({ labels: ["enhancement", "bug"] }) });
    const result = await readQaLabels(10, deps, DEFAULT_SPAWNED_AT);
    expect(result.hasPass).toBe(false);
    expect(result.hasFail).toBe(false);
  });

  test("trims whitespace around label names", async () => {
    const deps = makeDeps({
      gh: async (op) => {
        if (op.op === "pr:labels") return { stdout: "  qa:pass  \n  qa:fail  ", stderr: "", exitCode: 0 };
        if (op.op === "pr:label-events")
          return { stdout: JSON.stringify(validEventsFor(["qa:pass", "qa:fail"])), stderr: "", exitCode: 0 };
        if (op.op === "pr:author") return { stdout: DEFAULT_AUTHOR, stderr: "", exitCode: 0 };
        if (op.op === "pr:head-date") return { stdout: DEFAULT_HEAD_DATE, stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    });
    const result = await readQaLabels(10, deps, DEFAULT_SPAWNED_AT);
    expect(result).toMatchObject({ hasPass: true, hasFail: true });
  });
});

describe("readQaLabels — verdict validation (#2652)", () => {
  test("fail closed: label-events fetch failure rejects all verdicts", async () => {
    const deps = makeDeps({ gh: makeGh({ labels: ["qa:pass"], eventsExitCode: 1 }) });
    const result = await readQaLabels(10, deps, DEFAULT_SPAWNED_AT);
    expect(result.hasPass).toBe(false);
    expect(result.rejections.length).toBeGreaterThan(0);
    expect(result.rejections[0]).toMatch(/fail closed/);
  });

  test("fail closed: unparseable events JSON rejects all verdicts", async () => {
    const deps = makeDeps({
      gh: async (op) => {
        if (op.op === "pr:labels") return { stdout: "qa:pass", stderr: "", exitCode: 0 };
        if (op.op === "pr:label-events") return { stdout: "bad-json", stderr: "", exitCode: 0 };
        if (op.op === "pr:author") return { stdout: DEFAULT_AUTHOR, stderr: "", exitCode: 0 };
        if (op.op === "pr:head-date") return { stdout: DEFAULT_HEAD_DATE, stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    });
    const result = await readQaLabels(10, deps, DEFAULT_SPAWNED_AT);
    expect(result.hasPass).toBe(false);
    expect(result.rejections[0]).toMatch(/unparseable/);
  });

  test("fail closed: non-array label events rejects all verdicts (#2686)", async () => {
    const deps = makeDeps({
      gh: async (op) => {
        if (op.op === "pr:labels") return { stdout: "qa:pass", stderr: "", exitCode: 0 };
        if (op.op === "pr:label-events") return { stdout: '{"foo":1}', stderr: "", exitCode: 0 };
        if (op.op === "pr:author") return { stdout: DEFAULT_AUTHOR, stderr: "", exitCode: 0 };
        if (op.op === "pr:head-date") return { stdout: DEFAULT_HEAD_DATE, stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    });
    const result = await readQaLabels(10, deps, DEFAULT_SPAWNED_AT);
    expect(result.hasPass).toBe(false);
    expect(result.rejections[0]).toMatch(/label-events not an array/);
  });

  test("rejects stale label predating session spawn (guard b)", async () => {
    const staleEvent: GhLabelEvent = { actor: DEFAULT_AUTHOR, label: "qa:pass", created_at: "2026-06-09T09:55:00Z" };
    const deps = makeDeps({ gh: makeGh({ labels: ["qa:pass"], labelEvents: [staleEvent] }) });
    const result = await readQaLabels(10, deps, DEFAULT_SPAWNED_AT);
    expect(result.hasPass).toBe(false);
    expect(result.rejections[0]).toMatch(/stale verdict/);
  });

  test("rejects label predating head commit (guard c)", async () => {
    const event: GhLabelEvent = { actor: DEFAULT_AUTHOR, label: "qa:pass", created_at: "2026-06-09T10:05:00Z" };
    const deps = makeDeps({
      gh: makeGh({ labels: ["qa:pass"], labelEvents: [event], headDate: "2026-06-09T10:10:00Z" }),
    });
    const result = await readQaLabels(10, deps, DEFAULT_SPAWNED_AT);
    expect(result.hasPass).toBe(false);
    expect(result.rejections[0]).toMatch(/verdict on stale code/);
  });

  test("does not fetch events when no verdict label is present", async () => {
    let eventsFetched = false;
    const deps = makeDeps({
      gh: async (op) => {
        if (op.op === "pr:labels") return { stdout: "bug\nenhancement", stderr: "", exitCode: 0 };
        if (op.op === "pr:label-events") {
          eventsFetched = true;
          return { stdout: "[]", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    });
    await readQaLabels(10, deps, DEFAULT_SPAWNED_AT);
    expect(eventsFetched).toBe(false);
  });
});

describe("runQa — no session yet", () => {
  test("returns spawn action with correct fields", async () => {
    const state = makeState();
    const result = await runQa({ provider: "claude" }, makeWork(), state, makeDeps());
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") {
      expect(result.model).toBe("sonnet");
      expect(result.command).toContain("mcx");
      expect(result.allowTools.length).toBeGreaterThan(0);
    }
  });

  test("sets pending qa_session_id in state", async () => {
    const store: Record<string, unknown> = {};
    const state = makeState(store);
    await runQa({ provider: "claude" }, makeWork(), state, makeDeps());
    const id = await state.get<string>("qa_session_id");
    expect(id).toMatch(/^pending:/);
  });

  test("stores qa_spawned_at in state", async () => {
    const state = makeState();
    await runQa({ provider: "claude" }, makeWork(), state, makeDeps());
    const spawnedAt = await state.get<number>("qa_spawned_at");
    expect(spawnedAt).toBeGreaterThan(0);
  });

  test("uses --worktree flag when no worktree_path in state", async () => {
    const state = makeState();
    const result = await runQa({ provider: "claude" }, makeWork(), state, makeDeps());
    if (result.action === "spawn") {
      expect(result.command).toContain("--worktree");
    }
  });

  test("uses --cwd flag when worktree_path is set in state", async () => {
    const state = makeState({ worktree_path: "/tmp/wi-1" });
    const result = await runQa({ provider: "claude" }, makeWork(), state, makeDeps());
    if (result.action === "spawn") {
      expect(result.command).toContain("--cwd");
      expect(result.command).toContain("/tmp/wi-1");
    }
  });

  test("uses acp spawn command for acp: provider", async () => {
    const state = makeState();
    const result = await runQa({ provider: "acp:my-agent" }, makeWork(), state, makeDeps());
    if (result.action === "spawn") {
      expect(result.command).toContain("acp");
      expect(result.command).toContain("--agent");
      expect(result.command).toContain("my-agent");
    }
  });

  test("prompt includes issue and PR number", async () => {
    const state = makeState();
    const result = await runQa({ provider: "claude" }, makeWork({ issueNumber: 99, prNumber: 200 }), state, makeDeps());
    if (result.action === "spawn") {
      expect(result.prompt).toContain("99");
      expect(result.prompt).toContain("PR 200");
    }
  });

  test("omits the artifact-boot mandate by default (#2804)", async () => {
    const state = makeState();
    const result = await runQa({ provider: "claude" }, makeWork(), state, makeDeps());
    if (result.action === "spawn") {
      expect(result.prompt).not.toContain("ARTIFACT-BOOT MANDATE");
    }
  });

  test("appends the artifact-boot mandate when artifact_check=required (#2804)", async () => {
    const state = makeState({ artifact_check: "required" });
    const result = await runQa({ provider: "claude" }, makeWork(), state, makeDeps());
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") {
      expect(result.prompt).toContain("ARTIFACT-BOOT MANDATE");
      expect(result.command).toContain(result.prompt);
    }
  });
});

describe("runQa — session exists, waiting for labels", () => {
  test("returns wait when neither qa:pass nor qa:fail is set", async () => {
    const state = makeState({ qa_session_id: "abc-123", qa_spawned_at: DEFAULT_SPAWNED_AT });
    const deps = makeDeps({ gh: makeGh({ labels: ["enhancement"] }) });
    const result = await runQa({ provider: "claude" }, makeWork(), state, deps);
    expect(result.action).toBe("wait");
  });

  test("returns wait when qa_spawned_at is missing (fail closed)", async () => {
    const state = makeState({ qa_session_id: "abc-123" });
    const deps = makeDeps({ gh: makeGh({ labels: ["qa:pass"] }) });
    const result = await runQa({ provider: "claude" }, makeWork(), state, deps);
    expect(result.action).toBe("wait");
    if (result.action === "wait") expect(result.reason).toMatch(/fail closed/);
  });

  test("returns wait when qa_spawned_at is a string (typeof guard #2687)", async () => {
    const state = makeState({ qa_session_id: "abc-123", qa_spawned_at: "1718000000000" as unknown as number });
    const deps = makeDeps({ gh: makeGh({ labels: ["qa:pass"] }) });
    const result = await runQa({ provider: "claude" }, makeWork(), state, deps);
    expect(result.action).toBe("wait");
    if (result.action === "wait") expect(result.reason).toMatch(/fail closed/);
  });
});

// Regression for #2654: a QA session that dies before setting its verdict label
// must not idle the gate forever — bounded respawn, then needs-attention.
describe("runQa — dead-session backstop (#2654)", () => {
  const stuckState = (overrides: Record<string, unknown> = {}) =>
    makeState({ qa_session_id: "abc-123", qa_spawned_at: DEFAULT_SPAWNED_AT, ...overrides });
  const noLabelDeps = () => makeDeps({ gh: makeGh({ labels: ["enhancement"] }) });

  test("waits and increments the stuck tick while under the cap", async () => {
    const state = stuckState();
    const result = await runQa({ provider: "claude" }, makeWork(), state, noLabelDeps());
    expect(result.action).toBe("wait");
    expect(await state.get<number>("qa_stuck_ticks")).toBe(1);
  });

  test("respawns the QA session when the stuck tick cap is reached", async () => {
    const state = stuckState({ qa_stuck_ticks: QA_STUCK_TICK_CAP - 1 });
    const result = await runQa({ provider: "claude" }, makeWork(), state, noLabelDeps());
    expect(result.action).toBe("spawn");
    expect(await state.get<number>("qa_respawns")).toBe(1);
    expect(await state.get<string>("qa_session_id")).toMatch(/^pending:/);
    expect(await state.get<number>("qa_stuck_ticks")).toBe(0);
  });

  test("escalates to needs-attention once the respawn budget is exhausted", async () => {
    const state = stuckState({ qa_stuck_ticks: QA_STUCK_TICK_CAP - 1, qa_respawns: QA_RESPAWN_CAP });
    const result = await runQa({ provider: "claude" }, makeWork(), state, noLabelDeps());
    expect(result.action).toBe("goto");
    if (result.action === "goto") {
      expect(result.target).toBe("needs-attention");
      expect(result.reason).toMatch(/presumed dead/i);
    }
  });

  test("a valid verdict still routes normally despite accumulated stuck ticks", async () => {
    const state = stuckState({ qa_stuck_ticks: QA_STUCK_TICK_CAP - 1 });
    const deps = makeDeps({ gh: makeGh({ labels: ["qa:pass"] }) });
    const result = await runQa({ provider: "claude" }, makeWork(), state, deps);
    expect(result.action).toBe("goto");
    if (result.action === "goto") expect(result.target).toBe("done");
  });

  test("a fresh spawn resets the stuck tick counter", async () => {
    const state = makeState({ qa_stuck_ticks: 3 });
    await runQa({ provider: "claude" }, makeWork(), state, makeDeps());
    expect(await state.get<number>("qa_stuck_ticks")).toBe(0);
  });
});

describe("runQa — session exists, qa:pass", () => {
  test("returns goto done", async () => {
    const state = makeState({ qa_session_id: "abc-123", qa_spawned_at: DEFAULT_SPAWNED_AT });
    const deps = makeDeps({ gh: makeGh({ labels: ["qa:pass"] }) });
    const result = await runQa({ provider: "claude" }, makeWork(), state, deps);
    expect(result.action).toBe("goto");
    if (result.action === "goto") expect(result.target).toBe("done");
  });

  test("removes qa:fail label when both labels present", async () => {
    const state = makeState({ qa_session_id: "abc-123", qa_spawned_at: DEFAULT_SPAWNED_AT });
    const removedLabels: string[] = [];
    const deps = makeDeps({
      gh: makeGh({ labels: ["qa:pass", "qa:fail"] }),
      async prEdit(_prNumber, flags) {
        removedLabels.push(...flags);
      },
    });
    const result = await runQa({ provider: "claude" }, makeWork(), state, deps);
    expect(result.action).toBe("goto");
    if (result.action === "goto") expect(result.target).toBe("done");
    expect(removedLabels).toContain("qa:fail");
  });

  test("rejects stale qa:pass and returns wait with rejection reason", async () => {
    const staleEvent: GhLabelEvent = { actor: DEFAULT_AUTHOR, label: "qa:pass", created_at: "2026-06-09T09:55:00Z" };
    const state = makeState({ qa_session_id: "abc-123", qa_spawned_at: DEFAULT_SPAWNED_AT });
    const deps = makeDeps({ gh: makeGh({ labels: ["qa:pass"], labelEvents: [staleEvent] }) });
    const result = await runQa({ provider: "claude" }, makeWork(), state, deps);
    expect(result.action).toBe("wait");
    if (result.action === "wait") expect(result.reason).toMatch(/rejected.*stale/i);
  });
});

describe("runQa — session exists, qa:fail", () => {
  test("returns goto repair on first fail", async () => {
    const state = makeState({ qa_session_id: "abc-123", qa_spawned_at: DEFAULT_SPAWNED_AT });
    const deps = makeDeps({ gh: makeGh({ labels: ["qa:fail"] }) });
    const result = await runQa({ provider: "claude" }, makeWork(), state, deps);
    expect(result.action).toBe("goto");
    if (result.action === "goto") {
      expect(result.target).toBe("repair");
      expect(result.round).toBe(1);
    }
  });

  test("increments qa_fail_round in state", async () => {
    const state = makeState({ qa_session_id: "abc-123", qa_spawned_at: DEFAULT_SPAWNED_AT });
    const deps = makeDeps({ gh: makeGh({ labels: ["qa:fail"] }) });
    await runQa({ provider: "claude" }, makeWork(), state, deps);
    const round = await state.get<number>("qa_fail_round");
    expect(round).toBe(1);
  });

  test("sets previous_phase to qa", async () => {
    const state = makeState({ qa_session_id: "abc-123", qa_spawned_at: DEFAULT_SPAWNED_AT });
    const deps = makeDeps({ gh: makeGh({ labels: ["qa:fail"] }) });
    await runQa({ provider: "claude" }, makeWork(), state, deps);
    expect(await state.get<string>("previous_phase")).toBe("qa");
  });

  test("returns goto needs-attention when fail cap exceeded", async () => {
    const state = makeState({
      qa_session_id: "abc-123",
      qa_fail_round: QA_FAIL_CAP,
      qa_spawned_at: DEFAULT_SPAWNED_AT,
    });
    const deps = makeDeps({ gh: makeGh({ labels: ["qa:fail"] }) });
    const result = await runQa({ provider: "claude" }, makeWork(), state, deps);
    expect(result.action).toBe("goto");
    if (result.action === "goto") expect(result.target).toBe("needs-attention");
  });
});
