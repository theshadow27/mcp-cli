import { describe, expect, test } from "bun:test";
import { type TriageDeps, type TriageWork, runTriage } from "../.claude/phases/triage-fn";

function makeWork(overrides: Partial<TriageWork> = {}): TriageWork {
  return {
    id: "#42",
    issueNumber: 42,
    prNumber: null,
    branch: "feat/issue-42-test",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<TriageDeps> = {}): TriageDeps {
  return {
    findPr: () => null,
    runEstimate: () => ({ scrutiny: "low" as const, reasons: ["small diff"] }),
    waitForEvent: () => Promise.reject(new Error("waitForEvent not configured")),
    stateGet: () => Promise.resolve(undefined),
    stateSet: () => Promise.resolve(),
    updateWorkItem: () => Promise.resolve(),
    ...overrides,
  };
}

function makeTimeoutError(): Error {
  const err = new Error("waitForEvent timed out after 30000ms");
  err.name = "WaitTimeoutError";
  return err;
}

// ── Happy paths ──

describe("runTriage — PR available", () => {
  test("PR on work item — immediate triage, returns goto", async () => {
    const result = await runTriage(
      { labels: [] },
      makeWork({ prNumber: 100 }),
      makeDeps({
        runEstimate: () => ({ scrutiny: "low", reasons: ["small diff"] }),
      }),
    );
    expect(result).toMatchObject({
      action: "goto",
      target: "qa",
      scrutiny: "low",
      prNumber: 100,
    });
  });

  test("PR found via findPr — returns goto", async () => {
    const result = await runTriage(
      { labels: [] },
      makeWork(),
      makeDeps({
        findPr: () => 101,
        runEstimate: () => ({ scrutiny: "high", reasons: ["large diff"] }),
      }),
    );
    expect(result).toMatchObject({
      action: "goto",
      target: "review",
      scrutiny: "high",
      prNumber: 101,
    });
  });

  test("high scrutiny → target is review", async () => {
    const result = await runTriage(
      { labels: [] },
      makeWork({ prNumber: 100 }),
      makeDeps({
        runEstimate: () => ({ scrutiny: "high", reasons: ["complex"] }),
      }),
    );
    expect(result).toMatchObject({ action: "goto", target: "review" });
  });

  test("low scrutiny → target is qa", async () => {
    const result = await runTriage(
      { labels: [] },
      makeWork({ prNumber: 100 }),
      makeDeps({
        runEstimate: () => ({ scrutiny: "low", reasons: ["trivial"] }),
      }),
    );
    expect(result).toMatchObject({ action: "goto", target: "qa" });
  });

  test("flaky label forces high scrutiny", async () => {
    const result = await runTriage(
      { labels: ["flaky"] },
      makeWork({ prNumber: 100 }),
      makeDeps({
        runEstimate: () => ({ scrutiny: "low", reasons: ["small diff"] }),
      }),
    );
    expect(result).toMatchObject({
      action: "goto",
      target: "review",
      scrutiny: "high",
    });
    if (result.action === "goto") {
      expect(result.reason).toContain("label:flaky");
    }
  });

  test("flaky label from state when input labels empty", async () => {
    const result = await runTriage(
      { labels: [] },
      makeWork({ prNumber: 100 }),
      makeDeps({
        runEstimate: () => ({ scrutiny: "low", reasons: ["ok"] }),
        stateGet: async <T>(key: string): Promise<T | undefined> =>
          (key === "labels" ? "flaky" : undefined) as T | undefined,
      }),
    );
    expect(result).toMatchObject({
      action: "goto",
      target: "review",
      scrutiny: "high",
    });
  });

  test("metrics passed through from estimate", async () => {
    const metrics = { files: 3, additions: 42 };
    const result = await runTriage(
      { labels: [] },
      makeWork({ prNumber: 100 }),
      makeDeps({
        runEstimate: () => ({
          scrutiny: "low",
          reasons: ["ok"],
          metrics,
        }),
      }),
    );
    if (result.action === "goto") {
      expect(result.metrics).toEqual(metrics);
    }
  });
});

describe("runTriage — runEstimate failure", () => {
  test("runEstimate error propagates to caller", async () => {
    await expect(
      runTriage(
        { labels: [] },
        makeWork({ prNumber: 100 }),
        makeDeps({
          runEstimate: () => {
            throw new Error("triage.ts failed: exit code 1");
          },
        }),
      ),
    ).rejects.toThrow("triage.ts failed: exit code 1");
  });
});

// ── (a) Event arrives during wait → resolved with event ──

describe("runTriage — waitForEvent", () => {
  test("event arrives with prNumber → triage completes", async () => {
    const result = await runTriage(
      { labels: [] },
      makeWork(),
      makeDeps({
        findPr: () => null,
        waitForEvent: async () => ({ event: "pr.opened", prNumber: 200 }),
        runEstimate: () => ({ scrutiny: "low", reasons: ["ok"] }),
      }),
    );
    expect(result).toMatchObject({
      action: "goto",
      prNumber: 200,
    });
  });

  test("event arrives without prNumber, re-lookup succeeds", async () => {
    let calls = 0;
    const result = await runTriage(
      { labels: [] },
      makeWork(),
      makeDeps({
        findPr: () => {
          calls++;
          return calls >= 2 ? 201 : null;
        },
        waitForEvent: async () => ({ event: "session.result" }),
        runEstimate: () => ({ scrutiny: "low", reasons: ["ok"] }),
      }),
    );
    expect(result).toMatchObject({
      action: "goto",
      prNumber: 201,
    });
  });

  test("event arrives but re-lookup still fails → wait", async () => {
    const result = await runTriage(
      { labels: [] },
      makeWork(),
      makeDeps({
        findPr: () => null,
        waitForEvent: async () => ({ event: "session.result" }),
      }),
    );
    expect(result).toMatchObject({ action: "wait" });
    if (result.action === "wait") {
      expect(result.reason).toContain("no PR found");
    }
  });
});

// ── (b) Timeout elapses with no matching event → wait returned ──

describe("runTriage — timeout", () => {
  test("WaitTimeoutError → returns wait action", async () => {
    const result = await runTriage(
      { labels: [] },
      makeWork(),
      makeDeps({
        findPr: () => null,
        waitForEvent: () => Promise.reject(makeTimeoutError()),
      }),
    );
    expect(result).toMatchObject({ action: "wait" });
    if (result.action === "wait") {
      expect(result.reason).toContain("waiting for pr.opened or session.result");
    }
  });

  test("non-WaitTimeoutError is re-thrown", async () => {
    await expect(
      runTriage(
        { labels: [] },
        makeWork(),
        makeDeps({
          findPr: () => null,
          waitForEvent: () => Promise.reject(new Error("connection refused")),
        }),
      ),
    ).rejects.toThrow("connection refused");
  });
});

// ── (c) Replay path — since parameter for backfill window ──

describe("runTriage — replay", () => {
  test("waitForEvent receives correct filter and timeout", async () => {
    let capturedFilter: unknown;
    let capturedOpts: unknown;

    await runTriage(
      { labels: [] },
      makeWork({ id: "#99" }),
      makeDeps({
        findPr: () => null,
        waitForEvent: async (filter, opts) => {
          capturedFilter = filter;
          capturedOpts = opts;
          throw makeTimeoutError();
        },
      }),
    );

    expect(capturedFilter).toEqual({
      type: ["pr.opened", "session.result"],
      workItem: "#99",
    });
    expect(capturedOpts).toMatchObject({ timeoutMs: 30_000 });
  });

  test("since parameter passes through for backfill replay", async () => {
    let capturedOpts: unknown;

    await runTriage(
      { labels: [], since: 42 },
      makeWork(),
      makeDeps({
        findPr: () => null,
        waitForEvent: async (_filter, opts) => {
          capturedOpts = opts;
          throw makeTimeoutError();
        },
      }),
    );

    expect(capturedOpts).toEqual({ timeoutMs: 30_000, since: 42 });
  });

  test("timeoutMs input overrides default", async () => {
    let capturedOpts: unknown;

    await runTriage(
      { labels: [], timeoutMs: 5_000 },
      makeWork(),
      makeDeps({
        findPr: () => null,
        waitForEvent: async (_filter, opts) => {
          capturedOpts = opts;
          throw makeTimeoutError();
        },
      }),
    );

    expect(capturedOpts).toMatchObject({ timeoutMs: 5_000 });
  });

  test("replayed event with prNumber resolves triage", async () => {
    const result = await runTriage(
      { labels: [], since: 10 },
      makeWork(),
      makeDeps({
        findPr: () => null,
        waitForEvent: async () => ({
          event: "pr.opened",
          prNumber: 300,
        }),
        runEstimate: () => ({ scrutiny: "low", reasons: ["ok"] }),
      }),
    );
    expect(result).toMatchObject({
      action: "goto",
      prNumber: 300,
    });
  });
});

// ── findPr throws (exit code check from #1849) ──

describe("runTriage — findPr throws", () => {
  test("findPr throwing on first call propagates to caller", async () => {
    await expect(
      runTriage(
        { labels: [] },
        makeWork(),
        makeDeps({
          findPr: () => {
            throw new Error("gh pr list failed (exit 1): authentication required");
          },
        }),
      ),
    ).rejects.toThrow("gh pr list failed (exit 1): authentication required");
  });

  test("findPr throwing inside waitForEvent path is re-thrown (not caught as WaitTimeoutError)", async () => {
    let calls = 0;
    await expect(
      runTriage(
        { labels: [] },
        makeWork(),
        makeDeps({
          findPr: () => {
            calls++;
            if (calls === 1) return null;
            throw new Error("gh pr list failed (exit 1): network timeout");
          },
          waitForEvent: async () => ({ event: "session.result" }),
        }),
      ),
    ).rejects.toThrow("gh pr list failed (exit 1): network timeout");
  });
});

// ── Validation ──

describe("runTriage — validation", () => {
  test("throws when issueNumber missing", async () => {
    await expect(runTriage({ labels: [] }, makeWork({ issueNumber: null }), makeDeps())).rejects.toThrow("issueNumber");
  });

  test("throws when branch missing", async () => {
    await expect(runTriage({ labels: [] }, makeWork({ branch: null }), makeDeps())).rejects.toThrow("branch");
  });

  test("throws when branch is empty string", async () => {
    await expect(runTriage({ labels: [] }, makeWork({ branch: "" }), makeDeps())).rejects.toThrow("branch");
  });

  test("throws when both missing — lists both", async () => {
    await expect(runTriage({ labels: [] }, makeWork({ issueNumber: null, branch: null }), makeDeps())).rejects.toThrow(
      "issueNumber' and 'branch'",
    );
  });
});

// ── State writes ──

describe("runTriage — state", () => {
  test("writes triage_scrutiny and triage_reasons", async () => {
    const stateWrites: Record<string, unknown> = {};
    await runTriage(
      { labels: [] },
      makeWork({ prNumber: 100 }),
      makeDeps({
        runEstimate: () => ({ scrutiny: "low", reasons: ["small", "clean"] }),
        stateSet: async (key, value) => {
          stateWrites[key] = value;
        },
      }),
    );
    expect(stateWrites.triage_scrutiny).toBe("low");
    expect(stateWrites.triage_reasons).toBe("small; clean");
  });

  test("updateWorkItem connectivity failure is swallowed", async () => {
    const result = await runTriage(
      { labels: [] },
      makeWork({ prNumber: 100 }),
      makeDeps({
        runEstimate: () => ({ scrutiny: "low", reasons: ["ok"] }),
        updateWorkItem: () => Promise.reject(new Error("ECONNREFUSED")),
      }),
    );
    expect(result.action).toBe("goto");
  });

  test("updateWorkItem non-connectivity error is re-thrown", async () => {
    await expect(
      runTriage(
        { labels: [] },
        makeWork({ prNumber: 100 }),
        makeDeps({
          runEstimate: () => ({ scrutiny: "low", reasons: ["ok"] }),
          updateWorkItem: () => Promise.reject(new Error("schema validation failed")),
        }),
      ),
    ).rejects.toThrow("schema validation failed");
  });

  test("updateWorkItem called with correct args", async () => {
    let calledWith: { id: string; prNumber: number } | undefined;
    await runTriage(
      { labels: [] },
      makeWork({ id: "#55", prNumber: 100 }),
      makeDeps({
        runEstimate: () => ({ scrutiny: "low", reasons: ["ok"] }),
        updateWorkItem: async (id, prNumber) => {
          calledWith = { id, prNumber };
        },
      }),
    );
    expect(calledWith).toEqual({ id: "#55", prNumber: 100 });
  });
});
