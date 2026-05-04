import { describe, expect, test } from "bun:test";
import {
  type NeedsAttentionDeps,
  type NeedsAttentionState,
  type NeedsAttentionWork,
  buildNeedsAttentionBody,
  runNeedsAttention,
} from "../.claude/phases/needs-attention-fn";

function makeWork(overrides: Partial<NeedsAttentionWork> = {}): NeedsAttentionWork {
  return { id: "#42", prNumber: 100, issueNumber: 42, ...overrides };
}

function makeState(initial: Record<string, unknown> = {}): NeedsAttentionState {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: async <T>(key: string) => store.get(key) as T | undefined,
  };
}

function makeDeps(overrides: Partial<NeedsAttentionDeps> = {}): NeedsAttentionDeps {
  return {
    prEdit: async () => {},
    prComment: async () => {},
    updateWorkItemPhase: async () => {},
    ...overrides,
  };
}

// ── buildNeedsAttentionBody ──

describe("buildNeedsAttentionBody — pure function", () => {
  test("includes PR number", () => {
    const body = buildNeedsAttentionBody(42, 2, 3, 1, "high");
    expect(body).toContain("PR #42");
  });

  test("includes round counts", () => {
    const body = buildNeedsAttentionBody(42, 2, 3, 1, "high");
    expect(body).toContain("| Review     | 2 |");
    expect(body).toContain("| Repair     | 3 |");
    expect(body).toContain("| QA fail    | 1 |");
  });

  test("includes triage scrutiny level", () => {
    const body = buildNeedsAttentionBody(42, 0, 0, 0, "low");
    expect(body).toContain("**low**");
  });

  test("includes operator guidance", () => {
    const body = buildNeedsAttentionBody(42, 0, 0, 0, "high");
    expect(body).toContain("refining the issue spec");
    expect(body).toContain("taking over the PR manually");
  });

  test("starts with needs attention header", () => {
    const body = buildNeedsAttentionBody(42, 0, 0, 0, "unknown");
    expect(body).toMatch(/^## 🚩 Needs attention/);
  });
});

// ── runNeedsAttention ──

describe("runNeedsAttention — state reading", () => {
  test("reads round counts from state", async () => {
    const result = await runNeedsAttention(
      makeWork(),
      makeState({ review_round: 2, repair_round: 3, qa_fail_round: 1 }),
      makeDeps(),
    );
    expect(result.reviewRound).toBe(2);
    expect(result.repairRound).toBe(3);
    expect(result.qaFailRound).toBe(1);
  });

  test("defaults to 0 when state keys missing", async () => {
    const result = await runNeedsAttention(makeWork(), makeState(), makeDeps());
    expect(result.reviewRound).toBe(0);
    expect(result.repairRound).toBe(0);
    expect(result.qaFailRound).toBe(0);
  });

  test("returns correct prNumber and issueNumber", async () => {
    const result = await runNeedsAttention(makeWork({ prNumber: 55, issueNumber: 99 }), makeState(), makeDeps());
    expect(result.prNumber).toBe(55);
    expect(result.issueNumber).toBe(99);
  });
});

describe("runNeedsAttention — side effects", () => {
  test("removes qa:pass and qa:fail labels in parallel", async () => {
    const editCalls: Array<{ prNumber: number; flags: string[] }> = [];
    await runNeedsAttention(
      makeWork({ prNumber: 77 }),
      makeState(),
      makeDeps({
        prEdit: async (prNumber, flags) => {
          editCalls.push({ prNumber, flags });
        },
      }),
    );
    expect(editCalls.some((c) => c.prNumber === 77 && c.flags.includes("qa:pass"))).toBe(true);
    expect(editCalls.some((c) => c.prNumber === 77 && c.flags.includes("qa:fail"))).toBe(true);
  });

  test("prEdit failure is swallowed (best-effort)", async () => {
    await expect(
      runNeedsAttention(
        makeWork(),
        makeState(),
        makeDeps({
          prEdit: async () => {
            throw new Error("forbidden");
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  test("prComment called with body containing PR number", async () => {
    let capturedBody: string | undefined;
    await runNeedsAttention(
      makeWork({ prNumber: 55 }),
      makeState(),
      makeDeps({
        prComment: async (_, body) => {
          capturedBody = body;
        },
      }),
    );
    expect(capturedBody).toContain("PR #55");
  });

  test("prComment success → commented: true", async () => {
    const result = await runNeedsAttention(makeWork(), makeState(), makeDeps());
    expect(result.commented).toBe(true);
  });

  test("prComment failure → commented: false (best-effort)", async () => {
    const result = await runNeedsAttention(
      makeWork(),
      makeState(),
      makeDeps({
        prComment: async () => {
          throw new Error("network error");
        },
      }),
    );
    expect(result.commented).toBe(false);
  });

  test("updateWorkItemPhase called with correct args", async () => {
    let capturedId: string | undefined;
    let capturedPhase: string | undefined;
    await runNeedsAttention(
      makeWork({ id: "#99" }),
      makeState(),
      makeDeps({
        updateWorkItemPhase: async (id, phase) => {
          capturedId = id;
          capturedPhase = phase;
        },
      }),
    );
    expect(capturedId).toBe("#99");
    expect(capturedPhase).toBe("needs-attention");
  });

  test("updateWorkItemPhase failure is swallowed (non-fatal)", async () => {
    await expect(
      runNeedsAttention(
        makeWork(),
        makeState(),
        makeDeps({
          updateWorkItemPhase: async () => {
            throw new Error("ECONNREFUSED");
          },
        }),
      ),
    ).resolves.toBeDefined();
  });
});
