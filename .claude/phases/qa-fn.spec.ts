import { describe, expect, test } from "bun:test";
import { QA_FAIL_CAP, type QaDeps, type QaState, type QaWork, readQaLabels, runQa } from "./qa-fn";

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

function makeDeps(overrides: Partial<QaDeps> = {}): QaDeps {
  return {
    async gh(_args) {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async prEdit(_prNumber, _flags) {},
    ...overrides,
  };
}

describe("readQaLabels", () => {
  test("returns hasPass=true when qa:pass label present", async () => {
    const deps = makeDeps({
      async gh() {
        return { stdout: "qa:pass\nbug\n", stderr: "", exitCode: 0 };
      },
    });
    const result = await readQaLabels(10, deps);
    expect(result.hasPass).toBe(true);
    expect(result.hasFail).toBe(false);
  });

  test("returns hasFail=true when qa:fail label present", async () => {
    const deps = makeDeps({
      async gh() {
        return { stdout: "qa:fail\n", stderr: "", exitCode: 0 };
      },
    });
    const result = await readQaLabels(10, deps);
    expect(result.hasPass).toBe(false);
    expect(result.hasFail).toBe(true);
  });

  test("returns both true when both labels present", async () => {
    const deps = makeDeps({
      async gh() {
        return { stdout: "qa:pass\nqa:fail\n", stderr: "", exitCode: 0 };
      },
    });
    const result = await readQaLabels(10, deps);
    expect(result.hasPass).toBe(true);
    expect(result.hasFail).toBe(true);
  });

  test("returns both false when gh exits non-zero", async () => {
    const deps = makeDeps({
      async gh() {
        return { stdout: "", stderr: "auth error", exitCode: 1 };
      },
    });
    const result = await readQaLabels(10, deps);
    expect(result.hasPass).toBe(false);
    expect(result.hasFail).toBe(false);
  });

  test("returns both false when no qa labels present", async () => {
    const deps = makeDeps({
      async gh() {
        return { stdout: "enhancement\nbug\n", stderr: "", exitCode: 0 };
      },
    });
    const result = await readQaLabels(10, deps);
    expect(result.hasPass).toBe(false);
    expect(result.hasFail).toBe(false);
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
});

describe("runQa — session exists, waiting for labels", () => {
  test("returns wait when neither qa:pass nor qa:fail is set", async () => {
    const state = makeState({ qa_session_id: "abc-123" });
    const deps = makeDeps({
      async gh() {
        return { stdout: "enhancement\n", stderr: "", exitCode: 0 };
      },
    });
    const result = await runQa({ provider: "claude" }, makeWork(), state, deps);
    expect(result.action).toBe("wait");
  });
});

describe("runQa — session exists, qa:pass", () => {
  test("returns goto done", async () => {
    const state = makeState({ qa_session_id: "abc-123" });
    const deps = makeDeps({
      async gh() {
        return { stdout: "qa:pass\n", stderr: "", exitCode: 0 };
      },
    });
    const result = await runQa({ provider: "claude" }, makeWork(), state, deps);
    expect(result.action).toBe("goto");
    if (result.action === "goto") expect(result.target).toBe("done");
  });

  test("removes qa:fail label when both labels present", async () => {
    const state = makeState({ qa_session_id: "abc-123" });
    const removedLabels: string[] = [];
    const deps = makeDeps({
      async gh() {
        return { stdout: "qa:pass\nqa:fail\n", stderr: "", exitCode: 0 };
      },
      async prEdit(_prNumber, flags) {
        removedLabels.push(...flags);
      },
    });
    const result = await runQa({ provider: "claude" }, makeWork(), state, deps);
    expect(result.action).toBe("goto");
    if (result.action === "goto") expect(result.target).toBe("done");
    expect(removedLabels).toContain("qa:fail");
  });
});

describe("runQa — session exists, qa:fail", () => {
  test("returns goto repair on first fail", async () => {
    const state = makeState({ qa_session_id: "abc-123" });
    const deps = makeDeps({
      async gh() {
        return { stdout: "qa:fail\n", stderr: "", exitCode: 0 };
      },
    });
    const result = await runQa({ provider: "claude" }, makeWork(), state, deps);
    expect(result.action).toBe("goto");
    if (result.action === "goto") {
      expect(result.target).toBe("repair");
      expect(result.round).toBe(1);
    }
  });

  test("increments qa_fail_round in state", async () => {
    const state = makeState({ qa_session_id: "abc-123" });
    const deps = makeDeps({
      async gh() {
        return { stdout: "qa:fail\n", stderr: "", exitCode: 0 };
      },
    });
    await runQa({ provider: "claude" }, makeWork(), state, deps);
    const round = await state.get<number>("qa_fail_round");
    expect(round).toBe(1);
  });

  test("sets previous_phase to qa", async () => {
    const state = makeState({ qa_session_id: "abc-123" });
    const deps = makeDeps({
      async gh() {
        return { stdout: "qa:fail\n", stderr: "", exitCode: 0 };
      },
    });
    await runQa({ provider: "claude" }, makeWork(), state, deps);
    expect(await state.get<string>("previous_phase")).toBe("qa");
  });

  test("returns goto needs-attention when fail cap exceeded", async () => {
    const state = makeState({ qa_session_id: "abc-123", qa_fail_round: QA_FAIL_CAP });
    const deps = makeDeps({
      async gh() {
        return { stdout: "qa:fail\n", stderr: "", exitCode: 0 };
      },
    });
    const result = await runQa({ provider: "claude" }, makeWork(), state, deps);
    expect(result.action).toBe("goto");
    if (result.action === "goto") expect(result.target).toBe("needs-attention");
  });
});
