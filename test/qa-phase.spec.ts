import { describe, expect, test } from "bun:test";
import type { GhResult } from "../.claude/phases/gh";
import { QA_FAIL_CAP, type QaDeps, type QaState, type QaWork, readQaLabels, runQa } from "../.claude/phases/qa-fn";

function ok(stdout = ""): GhResult {
  return { stdout, stderr: "", exitCode: 0 };
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
    gh: async () => ok(""),
    prEdit: async () => {},
    ...overrides,
  };
}

// ── readQaLabels ──

describe("readQaLabels — parsing", () => {
  test("empty labels → hasPass: false, hasFail: false", async () => {
    const result = await readQaLabels(100, { gh: async () => ok("") });
    expect(result).toEqual({ hasPass: false, hasFail: false });
  });

  test("qa:pass only", async () => {
    const result = await readQaLabels(100, { gh: async () => ok("qa:pass") });
    expect(result).toEqual({ hasPass: true, hasFail: false });
  });

  test("qa:fail only", async () => {
    const result = await readQaLabels(100, { gh: async () => ok("qa:fail") });
    expect(result).toEqual({ hasPass: false, hasFail: true });
  });

  test("both qa:pass and qa:fail", async () => {
    const result = await readQaLabels(100, { gh: async () => ok("qa:pass\nqa:fail") });
    expect(result).toEqual({ hasPass: true, hasFail: true });
  });

  test("gh call fails → both false", async () => {
    const result = await readQaLabels(100, {
      gh: async () => ({ stdout: "", stderr: "not found", exitCode: 1 }),
    });
    expect(result).toEqual({ hasPass: false, hasFail: false });
  });

  test("labels with extra whitespace are trimmed", async () => {
    const result = await readQaLabels(100, { gh: async () => ok("  qa:pass  \n  qa:fail  ") });
    expect(result).toEqual({ hasPass: true, hasFail: true });
  });

  test("passes correct args to gh", async () => {
    let captured: string[] | undefined;
    await readQaLabels(99, {
      gh: async (args) => {
        captured = args;
        return ok("");
      },
    });
    expect(captured).toEqual(["pr", "view", "99", "--json", "labels", "-q", ".labels[].name"]);
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

  test("writes qa_session_id sentinel", async () => {
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
  });
});

// ── runQa — wait path ──

describe("runQa — wait path", () => {
  test("session set, no labels → wait", async () => {
    const result = await runQa(
      { provider: "claude" },
      makeWork(),
      makeState({ qa_session_id: "sess_123" }),
      makeDeps({ gh: async () => ok("") }),
    );
    expect(result.action).toBe("wait");
  });
});

// ── runQa — verdict paths ──

describe("runQa — qa:pass verdict", () => {
  test("qa:pass → goto done", async () => {
    const result = await runQa(
      { provider: "claude" },
      makeWork(),
      makeState({ qa_session_id: "sess_123" }),
      makeDeps({ gh: async () => ok("qa:pass") }),
    );
    expect(result).toMatchObject({ action: "goto", target: "done" });
  });

  test("qa:pass + qa:fail → goto done, removes qa:fail", async () => {
    const editCalls: Array<{ prNumber: number; flags: string[] }> = [];
    const result = await runQa(
      { provider: "claude" },
      makeWork(),
      makeState({ qa_session_id: "sess_123" }),
      makeDeps({
        gh: async () => ok("qa:pass\nqa:fail"),
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
      makeState({ qa_session_id: "sess_123", qa_fail_round: 0 }),
      makeDeps({ gh: async () => ok("qa:fail") }),
    );
    expect(result).toMatchObject({ action: "goto", target: "repair" });
  });

  test("qa:fail at cap → goto needs-attention", async () => {
    const result = await runQa(
      { provider: "claude" },
      makeWork(),
      makeState({ qa_session_id: "sess_123", qa_fail_round: QA_FAIL_CAP }),
      makeDeps({ gh: async () => ok("qa:fail") }),
    );
    expect(result).toMatchObject({ action: "goto", target: "needs-attention" });
    if (result.action === "goto") expect(result.reason).toContain("cap");
  });

  test("qa:fail writes qa_fail_round and previous_phase", async () => {
    const writes: Record<string, unknown> = {};
    const state = makeState({ qa_session_id: "sess_123" });
    const trackingState: QaState = {
      get: state.get,
      set: async (key, value) => {
        writes[key] = value;
        await state.set(key, value);
      },
      delete: state.delete,
    };
    await runQa({ provider: "claude" }, makeWork(), trackingState, makeDeps({ gh: async () => ok("qa:fail") }));
    expect(writes.qa_fail_round).toBe(1);
    expect(writes.previous_phase).toBe("qa");
  });

  test("round count is cumulative across calls", async () => {
    const result = await runQa(
      { provider: "claude" },
      makeWork(),
      makeState({ qa_session_id: "sess_123", qa_fail_round: 1 }),
      makeDeps({ gh: async () => ok("qa:fail") }),
    );
    expect(result).toMatchObject({ action: "goto", target: "repair" });
    if (result.action === "goto") {
      expect(result.round).toBe(2);
    }
  });
});
