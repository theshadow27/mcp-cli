import { describe, expect, test } from "bun:test";
import { REPAIR_ROUND_CAP, type RepairDeps, type RepairState, type RepairWork, buildRepairPrompt, runRepair } from "./repair-fn";

function makeWork(overrides: Partial<RepairWork> = {}): RepairWork {
  return { id: "wi-1", prNumber: 30, ...overrides };
}

function makeState(initial: Record<string, unknown> = {}): RepairState {
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

function makeDeps(overrides: Partial<RepairDeps> = {}): RepairDeps {
  return {
    async prEdit(_prNumber, _flags) {},
    ...overrides,
  };
}

describe("buildRepairPrompt", () => {
  test("references qa:fail comment for qa previous phase", () => {
    const prompt = buildRepairPrompt(30, "qa");
    expect(prompt).toMatch(/qa:fail/i);
    expect(prompt).toContain("30");
  });

  test("references adversarial review for review previous phase", () => {
    const prompt = buildRepairPrompt(30, "review");
    expect(prompt).toMatch(/adversarial review/i);
    expect(prompt).toContain("30");
  });

  test("includes push instruction", () => {
    expect(buildRepairPrompt(30, "qa")).toMatch(/push/i);
    expect(buildRepairPrompt(30, "review")).toMatch(/push/i);
  });
});

describe("runRepair — session already in flight", () => {
  test("returns in-flight when repair_session_id is set", async () => {
    const state = makeState({ repair_session_id: "abc-123", repair_round: 1 });
    const result = await runRepair({ provider: "claude" }, makeWork(), state, makeDeps());
    expect(result.action).toBe("in-flight");
    if (result.action === "in-flight") {
      expect(result.round).toBe(1);
      expect(result.model).toBe("opus");
    }
  });

  test("includes stored prompt in in-flight result", async () => {
    const state = makeState({
      repair_session_id: "abc-123",
      repair_round: 2,
      repair_prompt: "Repair PR #30. Read the qa:fail comment...",
    });
    const result = await runRepair({ provider: "claude" }, makeWork(), state, makeDeps());
    if (result.action === "in-flight") {
      expect(result.prompt).toMatch(/qa:fail/i);
    }
  });
});

describe("runRepair — no session, within cap", () => {
  test("returns spawn action", async () => {
    const state = makeState({ previous_phase: "review" });
    const result = await runRepair({ provider: "claude" }, makeWork(), state, makeDeps());
    expect(result.action).toBe("spawn");
  });

  test("uses opus model", async () => {
    const state = makeState({ previous_phase: "qa" });
    const result = await runRepair({ provider: "claude" }, makeWork(), state, makeDeps());
    if (result.action === "spawn") expect(result.model).toBe("opus");
  });

  test("round starts at 1 when no prior repair round", async () => {
    const state = makeState({ previous_phase: "review" });
    const result = await runRepair({ provider: "claude" }, makeWork(), state, makeDeps());
    if (result.action === "spawn") expect(result.round).toBe(1);
  });

  test("increments round from prior state", async () => {
    const state = makeState({ previous_phase: "review", repair_round: 1 });
    const result = await runRepair({ provider: "claude" }, makeWork(), state, makeDeps());
    if (result.action === "spawn") expect(result.round).toBe(2);
  });

  test("sets repair_session_id as pending", async () => {
    const state = makeState({ previous_phase: "review" });
    await runRepair({ provider: "claude" }, makeWork(), state, makeDeps());
    const id = await state.get<string>("repair_session_id");
    expect(id).toMatch(/^pending:/);
  });

  test("clears qa_session_id and review_session_id", async () => {
    const state = makeState({
      previous_phase: "review",
      qa_session_id: "old-qa",
      review_session_id: "old-review",
    });
    await runRepair({ provider: "claude" }, makeWork(), state, makeDeps());
    expect(await state.get<string>("qa_session_id")).toBeUndefined();
    expect(await state.get<string>("review_session_id")).toBeUndefined();
  });

  test("calls prEdit to remove qa:fail label", async () => {
    const removedFlags: string[][] = [];
    const deps = makeDeps({
      async prEdit(_prNumber, flags) {
        removedFlags.push(flags);
      },
    });
    const state = makeState({ previous_phase: "qa" });
    await runRepair({ provider: "claude" }, makeWork(), state, deps);
    expect(removedFlags.some((f) => f.includes("qa:fail"))).toBe(true);
  });

  test("generates qa-style prompt when previous_phase is qa", async () => {
    const state = makeState({ previous_phase: "qa" });
    const result = await runRepair({ provider: "claude" }, makeWork(), state, makeDeps());
    if (result.action === "spawn") expect(result.prompt).toMatch(/qa:fail/i);
  });

  test("generates review-style prompt when previous_phase is review", async () => {
    const state = makeState({ previous_phase: "review" });
    const result = await runRepair({ provider: "claude" }, makeWork(), state, makeDeps());
    if (result.action === "spawn") expect(result.prompt).toMatch(/adversarial review/i);
  });

  test("defaults to review prompt when previous_phase is absent", async () => {
    const state = makeState();
    const result = await runRepair({ provider: "claude" }, makeWork(), state, makeDeps());
    if (result.action === "spawn") expect(result.prompt).toMatch(/adversarial review/i);
  });

  test("uses --cwd flag when worktree_path is set", async () => {
    const state = makeState({ previous_phase: "review", worktree_path: "/tmp/wi-1" });
    const result = await runRepair({ provider: "claude" }, makeWork(), state, makeDeps());
    if (result.action === "spawn") {
      expect(result.command).toContain("--cwd");
      expect(result.command).toContain("/tmp/wi-1");
    }
  });

  test("uses --worktree flag when no worktree_path in state", async () => {
    const state = makeState({ previous_phase: "review" });
    const result = await runRepair({ provider: "claude" }, makeWork(), state, makeDeps());
    if (result.action === "spawn") {
      expect(result.command).toContain("--worktree");
    }
  });

  test("uses acp spawn command for acp: provider", async () => {
    const state = makeState({ previous_phase: "review" });
    const result = await runRepair({ provider: "acp:fixer" }, makeWork(), state, makeDeps());
    if (result.action === "spawn") {
      expect(result.command).toContain("acp");
      expect(result.command).toContain("--agent");
      expect(result.command).toContain("fixer");
    }
  });
});

describe("runRepair — cap exceeded", () => {
  test("returns goto needs-attention when round > cap", async () => {
    const state = makeState({ previous_phase: "review", repair_round: REPAIR_ROUND_CAP });
    const result = await runRepair({ provider: "claude" }, makeWork(), state, makeDeps());
    expect(result.action).toBe("goto");
    if (result.action === "goto") {
      expect(result.target).toBe("needs-attention");
      expect(result.reason).toMatch(/cap/i);
    }
  });

  test("does not spawn or modify state when cap exceeded", async () => {
    const sets: string[] = [];
    const state: RepairState = {
      async get<T>(key: string) {
        if (key === "repair_round") return REPAIR_ROUND_CAP as T;
        return undefined;
      },
      async set(key) {
        sets.push(key);
      },
      async delete() {},
    };
    await runRepair({ provider: "claude" }, makeWork(), state, makeDeps());
    expect(sets).toHaveLength(0);
  });
});
