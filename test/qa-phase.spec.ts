import { describe, expect, test } from "bun:test";
import type { GhLabelEvent } from "../.claude/phases/phase-types";
import type { GhOp, GhResult } from "../.claude/phases/qa-fn";
import { QA_FAIL_CAP, type QaDeps, type QaState, type QaWork, readQaLabels, runQa } from "../.claude/phases/qa-fn";

const DEFAULT_SPAWNED_AT = new Date("2026-06-09T10:00:00Z").getTime();
const DEFAULT_HEAD_DATE = "2026-06-09T09:50:00Z";
const DEFAULT_EVENT_TIME = "2026-06-09T10:05:00Z";
const DEFAULT_AUTHOR = "bot-user";

function ok(stdout = ""): GhResult {
  return { stdout, stderr: "", exitCode: 0 };
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
}

function makeGh(opts: GhStubOpts = {}): QaDeps["gh"] {
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

function makeWork(overrides: Partial<QaWork> = {}): QaWork {
  return {
    id: "#42",
    prNumber: 100,
    branch: "feat/issue-42-test",
    issueNumber: 42,
    ...overrides,
  };
}

function makeState(initial: Record<string, unknown> = {}): QaState {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: async <T>(key: string) => store.get(key) as T | undefined,
    set: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
  };
}

function makeDeps(overrides: Partial<QaDeps> = {}): QaDeps {
  return {
    gh: makeGh(),
    prEdit: async () => {},
    ...overrides,
  };
}

// ── readQaLabels ──

describe("readQaLabels — parsing", () => {
  test("empty labels → hasPass: false, hasFail: false", async () => {
    const result = await readQaLabels(100, { gh: makeGh() }, DEFAULT_SPAWNED_AT);
    expect(result).toMatchObject({ hasPass: false, hasFail: false });
  });

  test("qa:pass only", async () => {
    const result = await readQaLabels(100, { gh: makeGh({ labels: ["qa:pass"] }) }, DEFAULT_SPAWNED_AT);
    expect(result).toMatchObject({ hasPass: true, hasFail: false });
  });

  test("qa:fail only", async () => {
    const result = await readQaLabels(100, { gh: makeGh({ labels: ["qa:fail"] }) }, DEFAULT_SPAWNED_AT);
    expect(result).toMatchObject({ hasPass: false, hasFail: true });
  });

  test("both qa:pass and qa:fail", async () => {
    const result = await readQaLabels(100, { gh: makeGh({ labels: ["qa:pass", "qa:fail"] }) }, DEFAULT_SPAWNED_AT);
    expect(result).toMatchObject({ hasPass: true, hasFail: true });
  });

  test("gh call fails → both false", async () => {
    const result = await readQaLabels(
      100,
      {
        gh: async () => ({ stdout: "", stderr: "not found", exitCode: 1 }),
      },
      DEFAULT_SPAWNED_AT,
    );
    expect(result).toMatchObject({ hasPass: false, hasFail: false });
  });

  test("labels with extra whitespace are trimmed", async () => {
    const deps: Pick<QaDeps, "gh"> = {
      gh: async (op) => {
        if (op.op === "pr:labels") return ok("  qa:pass  \n  qa:fail  ");
        if (op.op === "pr:label-events")
          return { stdout: JSON.stringify(validEventsFor(["qa:pass", "qa:fail"])), stderr: "", exitCode: 0 };
        if (op.op === "pr:author") return ok(DEFAULT_AUTHOR);
        if (op.op === "pr:head-date") return ok(DEFAULT_HEAD_DATE);
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    };
    const result = await readQaLabels(100, deps, DEFAULT_SPAWNED_AT);
    expect(result).toMatchObject({ hasPass: true, hasFail: true });
  });

  test("label-events fetch failure → fail closed (both false)", async () => {
    const result = await readQaLabels(
      100,
      { gh: makeGh({ labels: ["qa:pass"], eventsExitCode: 1 }) },
      DEFAULT_SPAWNED_AT,
    );
    expect(result).toMatchObject({ hasPass: false, hasFail: false });
    expect(result.rejections.length).toBeGreaterThan(0);
    expect(result.rejections[0]).toMatch(/label-events fetch failed/);
  });

  test("unparseable label-events JSON → fail closed", async () => {
    const gh: QaDeps["gh"] = async (op) => {
      if (op.op === "pr:labels") return ok("qa:pass");
      if (op.op === "pr:label-events") return { stdout: "not-json{{{", stderr: "", exitCode: 0 };
      if (op.op === "pr:author") return ok(DEFAULT_AUTHOR);
      if (op.op === "pr:head-date") return ok(DEFAULT_HEAD_DATE);
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const result = await readQaLabels(100, { gh }, DEFAULT_SPAWNED_AT);
    expect(result).toMatchObject({ hasPass: false, hasFail: false });
    expect(result.rejections[0]).toMatch(/unparseable/);
  });

  test("stale label (predates session spawn) → hasPass false + rejection", async () => {
    const staleEvent = { actor: DEFAULT_AUTHOR, label: "qa:pass", created_at: "2026-06-09T09:55:00Z" };
    const result = await readQaLabels(
      100,
      { gh: makeGh({ labels: ["qa:pass"], labelEvents: [staleEvent] }) },
      DEFAULT_SPAWNED_AT,
    );
    expect(result).toMatchObject({ hasPass: false, hasFail: false });
    expect(result.rejections[0]).toMatch(/stale verdict/);
  });

  test("label predates head commit → hasPass false + rejection", async () => {
    const earlyEvent = { actor: DEFAULT_AUTHOR, label: "qa:pass", created_at: "2026-06-09T10:05:00Z" };
    const result = await readQaLabels(
      100,
      { gh: makeGh({ labels: ["qa:pass"], labelEvents: [earlyEvent], headDate: "2026-06-09T10:10:00Z" }) },
      DEFAULT_SPAWNED_AT,
    );
    expect(result).toMatchObject({ hasPass: false, hasFail: false });
    expect(result.rejections[0]).toMatch(/verdict on stale code/);
  });

  test("no events fetched when no verdict label present", async () => {
    let eventsFetched = false;
    const gh: QaDeps["gh"] = async (op) => {
      if (op.op === "pr:labels") return ok("bug\nenhancement");
      if (op.op === "pr:label-events") {
        eventsFetched = true;
        return ok("[]");
      }
      return ok("");
    };
    const result = await readQaLabels(100, { gh }, DEFAULT_SPAWNED_AT);
    expect(result).toMatchObject({ hasPass: false, hasFail: false, rejections: [] });
    expect(eventsFetched).toBe(false);
  });

  test("passes correct op to gh", async () => {
    let captured: GhOp | undefined;
    await readQaLabels(
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

// ── runQa — spawn path ──

describe("runQa — spawn path", () => {
  test("no session → action: spawn", async () => {
    const result = await runQa({ provider: "claude" }, makeWork(), makeState(), makeDeps());
    expect(result.action).toBe("spawn");
  });

  test("spawn result includes model=sonnet", async () => {
    const result = await runQa({ provider: "claude" }, makeWork(), makeState(), makeDeps());
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") {
      expect(result.model).toBe("sonnet");
    }
  });

  test("prompt includes issue and PR number", async () => {
    const result = await runQa(
      { provider: "claude" },
      makeWork({ issueNumber: 99, prNumber: 200 }),
      makeState(),
      makeDeps(),
    );
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") {
      expect(result.prompt).toContain("99");
      expect(result.prompt).toContain("PR 200");
    }
  });

  test("command uses --worktree when no worktree_path in state", async () => {
    const result = await runQa({ provider: "claude" }, makeWork(), makeState(), makeDeps());
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") {
      expect(result.command).toContain("--worktree");
    }
  });

  test("command uses --cwd when worktree_path is in state", async () => {
    const result = await runQa(
      { provider: "claude" },
      makeWork(),
      makeState({ worktree_path: "/tmp/my-worktree" }),
      makeDeps(),
    );
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") {
      expect(result.command).toContain("--cwd");
      expect(result.command).toContain("/tmp/my-worktree");
    }
  });

  test("acp provider builds correct command", async () => {
    const result = await runQa({ provider: "acp:my-agent" }, makeWork(), makeState(), makeDeps());
    expect(result.action).toBe("spawn");
    if (result.action === "spawn") {
      expect(result.command).toEqual(expect.arrayContaining(["mcx", "acp", "spawn", "--agent", "my-agent"]));
    }
  });

  test("writes qa_session_id sentinel and qa_spawned_at", async () => {
    const writes: Record<string, unknown> = {};
    const state = makeState();
    const trackingState: QaState = {
      get: state.get,
      set: async (key, value) => {
        writes[key] = value;
        await state.set(key, value);
      },
      delete: state.delete,
    };
    await runQa({ provider: "claude" }, makeWork(), trackingState, makeDeps());
    expect(String(writes.qa_session_id)).toMatch(/^pending:/);
    expect(writes.qa_spawned_at).toBeGreaterThan(0);
  });
});

// ── runQa — wait path ──

describe("runQa — wait path", () => {
  test("session set, no labels → wait", async () => {
    const result = await runQa(
      { provider: "claude" },
      makeWork(),
      makeState({ qa_session_id: "sess_123", qa_spawned_at: DEFAULT_SPAWNED_AT }),
      makeDeps({ gh: makeGh() }),
    );
    expect(result.action).toBe("wait");
  });

  test("missing qa_spawned_at → wait (fail closed)", async () => {
    const result = await runQa(
      { provider: "claude" },
      makeWork(),
      makeState({ qa_session_id: "sess_123" }),
      makeDeps({ gh: makeGh({ labels: ["qa:pass"] }) }),
    );
    expect(result.action).toBe("wait");
    if (result.action === "wait") expect(result.reason).toMatch(/fail closed/);
  });
});

// ── runQa — verdict paths ──

describe("runQa — qa:pass verdict", () => {
  test("qa:pass → goto done", async () => {
    const result = await runQa(
      { provider: "claude" },
      makeWork(),
      makeState({ qa_session_id: "sess_123", qa_spawned_at: DEFAULT_SPAWNED_AT }),
      makeDeps({ gh: makeGh({ labels: ["qa:pass"] }) }),
    );
    expect(result).toMatchObject({ action: "goto", target: "done" });
  });

  test("qa:pass + qa:fail → goto done, removes qa:fail", async () => {
    const editCalls: Array<{ prNumber: number; flags: string[] }> = [];
    const result = await runQa(
      { provider: "claude" },
      makeWork(),
      makeState({ qa_session_id: "sess_123", qa_spawned_at: DEFAULT_SPAWNED_AT }),
      makeDeps({
        gh: makeGh({ labels: ["qa:pass", "qa:fail"] }),
        prEdit: async (prNumber, flags) => {
          editCalls.push({ prNumber, flags });
        },
      }),
    );
    expect(result).toMatchObject({ action: "goto", target: "done" });
    expect(editCalls.some((c) => c.flags.includes("qa:fail") && c.flags.includes("--remove-label"))).toBe(true);
  });
});

describe("runQa — qa:fail verdict", () => {
  test("qa:fail below cap → goto repair", async () => {
    const result = await runQa(
      { provider: "claude" },
      makeWork(),
      makeState({ qa_session_id: "sess_123", qa_fail_round: 0, qa_spawned_at: DEFAULT_SPAWNED_AT }),
      makeDeps({ gh: makeGh({ labels: ["qa:fail"] }) }),
    );
    expect(result).toMatchObject({ action: "goto", target: "repair" });
  });

  test("qa:fail at cap → goto needs-attention", async () => {
    const result = await runQa(
      { provider: "claude" },
      makeWork(),
      makeState({ qa_session_id: "sess_123", qa_fail_round: QA_FAIL_CAP, qa_spawned_at: DEFAULT_SPAWNED_AT }),
      makeDeps({ gh: makeGh({ labels: ["qa:fail"] }) }),
    );
    expect(result).toMatchObject({ action: "goto", target: "needs-attention" });
    expect(result.action).toBe("goto");
    if (result.action === "goto") expect(result.reason).toContain("cap");
  });

  test("qa:fail writes qa_fail_round and previous_phase", async () => {
    const writes: Record<string, unknown> = {};
    const state = makeState({ qa_session_id: "sess_123", qa_spawned_at: DEFAULT_SPAWNED_AT });
    const trackingState: QaState = {
      get: state.get,
      set: async (key, value) => {
        writes[key] = value;
        await state.set(key, value);
      },
      delete: state.delete,
    };
    await runQa({ provider: "claude" }, makeWork(), trackingState, makeDeps({ gh: makeGh({ labels: ["qa:fail"] }) }));
    expect(writes.qa_fail_round).toBe(1);
    expect(writes.previous_phase).toBe("qa");
  });

  test("round count is cumulative across calls", async () => {
    const result = await runQa(
      { provider: "claude" },
      makeWork(),
      makeState({ qa_session_id: "sess_123", qa_fail_round: 1, qa_spawned_at: DEFAULT_SPAWNED_AT }),
      makeDeps({ gh: makeGh({ labels: ["qa:fail"] }) }),
    );
    expect(result).toMatchObject({ action: "goto", target: "repair" });
    expect(result.action).toBe("goto");
    if (result.action === "goto") {
      expect(result.round).toBe(2);
    }
  });
});
