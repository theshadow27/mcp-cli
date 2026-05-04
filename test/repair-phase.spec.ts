import { describe, expect, test } from "bun:test";
import {
  REPAIR_ROUND_CAP,
  type RepairDeps,
  type RepairState,
  type RepairWork,
  buildRepairPrompt,
  runRepair,
} from "../.claude/phases/repair-fn";

function makeWork(overrides: Partial<RepairWork> = {}): RepairWork {
  return { id: "#42", prNumber: 100, ...overrides };
}

function makeState(initial: Record<string, unknown> = {}): RepairState {
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

function makeDeps(overrides: Partial<RepairDeps> = {}): RepairDeps {
  return {
    prEdit: async () => {},
    ...overrides,
  };
}

// ── buildRepairPrompt ──

describe("buildRepairPrompt — pure function", () => {
  test("review previous_phase → mentions adversarial review comment", () => {
    const prompt = buildRepairPrompt(42, "review");
    expect(prompt).toContain("42");
    expect(prompt).toContain("adversarial review");
    expect(prompt).toContain("🔴");
    expect(prompt).toContain("🟡");
  });

  test("qa previous_phase → mentions qa:fail comment", () => {
    const prompt = buildRepairPrompt(42, "qa");
    expect(prompt).toContain("42");
    expect(prompt).toContain("qa:fail");
  });

  test("repair prompt includes PR number in gh command", () => {
    const prompt = buildRepairPrompt(99, "review");
    expect(prompt).toContain("gh pr view 99");
  });
});

// ── runRepair — in-flight guard ──

describe("runRepair — in-flight", () => {
  test("existing session → action: in-flight", async () => {
    const result = await runRepair(
      { provider: "claude" },
      makeWork(),
      makeState({ repair_session_id: "sess_abc", repair_round: 2 }),
      makeDeps(),
    );
    expect(result.action).toBe("in-flight");
  });

  test("in-flight includes round and model", async () => {
    const result = await runRepair(
      { provider: "claude" },
      makeWork(),
      makeState({ repair_session_id: "sess_abc", repair_round: 2 }),
      makeDeps(),
    );
    if (result.action === "in-flight") {
      expect(result.round).toBe(2);
      expect(result.model).toBe("opus");
    }
  });

  test("in-flight includes stored prompt", async () => {
    const result = await runRepair(
      { provider: "claude" },
      makeWork(),
      makeState({ repair_session_id: "sess_abc", repair_round: 1, repair_prompt: "Fix PR #42" }),
      makeDeps(),
    );
    if (result.action === "in-flight") {
      expect(result.prompt).toBe("Fix PR #42");
    }
  });
});

// ── runRepair — cap exceeded ──

describe("runRepair — cap exceeded", () => {
  test("round > cap → goto needs-attention", async () => {
    const result = await runRepair(
      { provider: "claude" },
      makeWork(),
      makeState({ repair_round: REPAIR_ROUND_CAP }),
      makeDeps(),
    );
    expect(result).toMatchObject({ action: "goto", target: "needs-attention" });
    if (result.action === "goto") expect(result.reason).toContain("cap");
  });

  test("cap goto includes previous round in result", async () => {
    const result = await runRepair(
      { provider: "claude" },
      makeWork(),
      makeState({ repair_round: REPAIR_ROUND_CAP }),
      makeDeps(),
    );
    if (result.action === "goto") {
      expect(result.round).toBe(REPAIR_ROUND_CAP);
    }
  });
});

// ── runRepair — spawn path ──

describe("runRepair — spawn path", () => {
  test("no session, round 0 → action: spawn", async () => {
    const result = await runRepair({ provider: "claude" }, makeWork(), makeState(), makeDeps());
    expect(result.action).toBe("spawn");
  });

  test("spawn result model is opus", async () => {
    const result = await runRepair({ provider: "claude" }, makeWork(), makeState(), makeDeps());
    if (result.action === "spawn") {
      expect(result.model).toBe("opus");
    }
  });

  test("previous_phase=review → prompt references adversarial review", async () => {
    const result = await runRepair(
      { provider: "claude" },
      makeWork(),
      makeState({ previous_phase: "review" }),
      makeDeps(),
    );
    if (result.action === "spawn") {
      expect(result.prompt).toContain("adversarial review");
    }
  });

  test("previous_phase=qa → prompt references qa:fail", async () => {
    const result = await runRepair({ provider: "claude" }, makeWork(), makeState({ previous_phase: "qa" }), makeDeps());
    if (result.action === "spawn") {
      expect(result.prompt).toContain("qa:fail");
    }
  });

  test("default previous_phase is review", async () => {
    const result = await runRepair({ provider: "claude" }, makeWork(), makeState(), makeDeps());
    if (result.action === "spawn") {
      expect(result.prompt).toContain("adversarial review");
    }
  });

  test("command uses --worktree when no worktree_path", async () => {
    const result = await runRepair({ provider: "claude" }, makeWork(), makeState(), makeDeps());
    if (result.action === "spawn") {
      expect(result.command).toContain("--worktree");
    }
  });

  test("command uses --cwd when worktree_path is set", async () => {
    const result = await runRepair(
      { provider: "claude" },
      makeWork(),
      makeState({ worktree_path: "/tmp/my-worktree" }),
      makeDeps(),
    );
    if (result.action === "spawn") {
      expect(result.command).toContain("--cwd");
      expect(result.command).toContain("/tmp/my-worktree");
    }
  });

  test("acp provider builds correct command", async () => {
    const result = await runRepair({ provider: "acp:my-agent" }, makeWork(), makeState(), makeDeps());
    if (result.action === "spawn") {
      expect(result.command).toEqual(expect.arrayContaining(["mcx", "acp", "spawn", "--agent", "my-agent"]));
    }
  });

  test("writes repair_round, repair_prompt, repair_session_id", async () => {
    const writes: Record<string, unknown> = {};
    const state = makeState();
    const trackingState: RepairState = {
      get: state.get,
      set: async (key, value) => {
        writes[key] = value;
        await state.set(key, value);
      },
      delete: state.delete,
    };
    await runRepair({ provider: "claude" }, makeWork(), trackingState, makeDeps());
    expect(writes.repair_round).toBe(1);
    expect(typeof writes.repair_prompt).toBe("string");
    expect(String(writes.repair_session_id)).toMatch(/^pending:/);
  });

  test("clears qa_session_id before spawning", async () => {
    const deletedKeys: string[] = [];
    const state = makeState();
    const trackingState: RepairState = {
      get: state.get,
      set: state.set,
      delete: async (key) => {
        deletedKeys.push(key);
        await state.delete(key);
      },
    };
    await runRepair({ provider: "claude" }, makeWork(), trackingState, makeDeps());
    expect(deletedKeys).toContain("qa_session_id");
  });

  test("removes qa:fail label (best-effort)", async () => {
    const editCalls: Array<{ prNumber: number; flags: string[] }> = [];
    await runRepair(
      { provider: "claude" },
      makeWork({ prNumber: 55 }),
      makeState(),
      makeDeps({
        prEdit: async (prNumber, flags) => {
          editCalls.push({ prNumber, flags });
        },
      }),
    );
    expect(
      editCalls.some((c) => c.prNumber === 55 && c.flags.includes("qa:fail") && c.flags.includes("--remove-label")),
    ).toBe(true);
  });

  test("spawn includes reason with previous phase and round", async () => {
    const result = await runRepair({ provider: "claude" }, makeWork(), makeState({ previous_phase: "qa" }), makeDeps());
    if (result.action === "spawn") {
      expect(result.reason).toContain("round 1");
      expect(result.reason).toContain("qa");
    }
  });
});
