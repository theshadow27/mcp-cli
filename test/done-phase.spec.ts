import { describe, expect, test } from "bun:test";
import { type MergePrDeps, type ProcessHandle, mergePr, spawnWithTimeout } from "../.claude/phases/done-fn";
import type { GhOp, GhResult } from "../.claude/phases/done-fn";

function ok(stdout = ""): GhResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr = "oops", exitCode = 1): GhResult {
  return { stdout: "", stderr, exitCode };
}

function makeDeps(overrides: Partial<MergePrDeps> = {}): MergePrDeps {
  return {
    gh: async (op) => {
      // Default: labels returns qa:pass, CI returns 0 ungreen checks
      if (op.op === "pr:labels") return ok("qa:pass");
      if (op.op === "pr:checks") return ok("0");
      return ok();
    },
    prMerge: async () => ok(),
    prView: async () => "MERGED",
    spawn: async () => ok(),
    ...overrides,
  };
}

// ── Guard failures ──

describe("mergePr — label guard", () => {
  test("missing qa:pass → missing_qa_pass", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        gh: async (op) => {
          if (op.op === "pr:labels") return ok("needs-review");
          return ok("0");
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "missing_qa_pass" });
    if (!result.ok) expect(result.nextAction).toContain("spawn qa");
  });

  test("both qa:pass and qa:fail → inconsistent_labels (#2804)", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        gh: async (op) => {
          if (op.op === "pr:labels") return ok("qa:pass\nqa:fail");
          return ok("0");
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "inconsistent_labels" });
    if (!result.ok) expect(result.blockingLabels).toEqual(expect.arrayContaining(["qa:pass", "qa:fail"]));
  });

  test("lingering review:changes blocks merge → inconsistent_labels (#2804)", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        gh: async (op) => {
          if (op.op === "pr:labels") return ok("qa:pass\nreview:pass\nreview:changes");
          return ok("0");
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "inconsistent_labels" });
    if (!result.ok) expect(result.blockingLabels).toContain("review:changes");
  });

  test("gh labels call fails → merge_failed", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        gh: async (op) => {
          if (op.op === "pr:labels") return fail("auth required");
          return ok("0");
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "merge_failed" });
    if (!result.ok) expect(result.detail).toBe("auth required");
  });

  test("gh CI call fails → merge_failed", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        gh: async (op) => {
          if (op.op === "pr:labels") return ok("qa:pass");
          return fail("rate limited");
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "merge_failed" });
    if (!result.ok) expect(result.detail).toBe("rate limited");
  });

  test("ungreen CI checks → ci_not_green", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        gh: async (op) => {
          if (op.op === "pr:labels") return ok("qa:pass");
          return ok("3");
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "ci_not_green" });
  });

  test("non-numeric CI output → ci_not_green", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        gh: async (op) => {
          if (op.op === "pr:labels") return ok("qa:pass");
          return ok("null");
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "ci_not_green" });
  });
});

// ── Successful merge ──

describe("mergePr — success", () => {
  test("all guards pass → ok: true", async () => {
    const result = await mergePr(100, makeDeps());
    expect(result).toMatchObject({ ok: true, prNumber: 100 });
  });

  test("prMerge called with correct flags", async () => {
    let capturedPr: number | undefined;
    let capturedFlags: string[] | undefined;
    await mergePr(
      42,
      makeDeps({
        prMerge: async (prNumber, flags) => {
          capturedPr = prNumber;
          capturedFlags = flags;
          return ok();
        },
      }),
    );
    expect(capturedPr).toBe(42);
    expect(capturedFlags).toEqual(["--squash", "--delete-branch"]);
  });

  test("no pre-flight core.bare workaround (#1860)", async () => {
    const spawnCalls: string[][] = [];
    await mergePr(
      42,
      makeDeps({
        spawn: async (cmd) => {
          spawnCalls.push(cmd);
          return ok();
        },
      }),
    );
    const coreBareCall = spawnCalls.find((c) => c.includes("core.bare"));
    expect(coreBareCall).toBeUndefined();
  });
});

// ── Merge failure classification ──

describe("mergePr — merge failure paths", () => {
  test("conflict error → conflicts (prView confirms not merged)", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        prMerge: async () => fail("Pull Request is not mergeable"),
        prView: async () => "OPEN",
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "conflicts" });
    if (!result.ok) expect(result.detail).toContain("not mergeable");
  });

  test("'conflict' keyword → conflicts (prView confirms not merged)", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        prMerge: async () => fail("merge conflict detected"),
        prView: async () => "OPEN",
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "conflicts" });
  });

  test("required check error → missing_required_check (prView confirms not merged)", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        prMerge: async () => fail("required check 'CI' has not passed"),
        prView: async () => "OPEN",
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "missing_required_check" });
  });

  test("required status error → missing_required_check (prView confirms not merged)", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        prMerge: async () => fail("Required status check not passing"),
        prView: async () => "OPEN",
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "missing_required_check" });
  });

  test("'not mergeable' error but PR is already MERGED → ok:true (concurrent rerun guard)", async () => {
    // A second done invocation finds the PR already merged server-side.
    // GitHub returns "not mergeable" but prView confirms MERGED → must not
    // misclassify as conflicts and spawn a rebase worker.
    const result = await mergePr(
      100,
      makeDeps({
        prMerge: async () => fail("Pull Request is not mergeable"),
        prView: async () => "MERGED",
      }),
    );
    expect(result).toMatchObject({ ok: true, prNumber: 100 });
  });

  test("generic failure → merge_failed", async () => {
    const result = await mergePr(
      100,
      makeDeps({ prMerge: async () => fail("something unexpected"), prView: async () => "OPEN" }),
    );
    expect(result).toMatchObject({ ok: false, reason: "merge_failed" });
  });

  test("SIGTERM exit code (143) → poll state, if MERGED → ok with cleanup signal", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        prMerge: async () => ({ stdout: "", stderr: "killed", exitCode: 143 }),
        prView: async () => "MERGED",
      }),
    );
    expect(result).toMatchObject({ ok: true, prNumber: 100 });
    if (result.ok) expect(result.localCleanup).toContain("branch delete incomplete");
  });

  test("Go graceful SIGTERM (exit 1) → poll state, if MERGED → ok with cleanup signal", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        prMerge: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
        prView: async () => "MERGED",
      }),
    );
    expect(result).toMatchObject({ ok: true, prNumber: 100 });
    if (result.ok) expect(result.localCleanup).toContain("branch delete incomplete");
  });

  test("Go graceful SIGTERM (exit 1) + PR not merged → merge_failed", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        prMerge: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
        prView: async () => "OPEN",
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "merge_failed" });
  });

  test("worktree branch error → check PR state, if MERGED → ok with localCleanup", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        prMerge: async () => fail("cannot delete branch 'feat/foo' used by worktree"),
        prView: async () => "MERGED",
      }),
    );
    expect(result).toMatchObject({ ok: true, prNumber: 100 });
    if (result.ok) expect(result.localCleanup).toContain("worktree");
  });

  test("worktree branch error + PR not merged → merge_failed", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        prMerge: async () => fail("cannot delete branch 'feat/foo' used by worktree"),
        prView: async () => "OPEN",
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "merge_failed" });
  });

  test("worktree branch error + prView throws → merge_failed fallthrough", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        prMerge: async () => fail("cannot delete branch 'feat/foo' used by worktree"),
        prView: async () => {
          throw new Error("network error");
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "merge_failed" });
  });

  test("SIGKILL exit code (137) triggers maybeSucceeded check", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        prMerge: async () => ({ stdout: "", stderr: "killed", exitCode: 137 }),
        prView: async () => "MERGED",
      }),
    );
    expect(result).toMatchObject({ ok: true, prNumber: 100 });
  });
});

// ── Guard order ──

describe("mergePr — guard ordering", () => {
  test("gh calls happen in parallel (both ops captured)", async () => {
    const capturedOps: GhOp[] = [];
    await mergePr(
      100,
      makeDeps({
        gh: async (op) => {
          capturedOps.push(op);
          if (op.op === "pr:labels") return ok("qa:pass");
          return ok("0");
        },
      }),
    );
    // Both calls should have occurred
    expect(capturedOps.some((o) => o.op === "pr:labels")).toBe(true);
    expect(capturedOps.some((o) => o.op === "pr:checks")).toBe(true);
  });
});

// ── spawnWithTimeout — kill escalation ──

function makeStream(data = ""): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      if (data) controller.enqueue(encoder.encode(data));
      controller.close();
    },
  });
}

describe("spawnWithTimeout — kill escalation", () => {
  test("no timeout → process runs to completion without kill", async () => {
    const killCalls: Array<number | undefined> = [];
    const proc: ProcessHandle = {
      kill(signal?: number) {
        killCalls.push(signal);
      },
      stdout: makeStream("hello"),
      stderr: makeStream(),
      exited: Promise.resolve(0),
    };
    const result = await spawnWithTimeout(["true"], undefined, {
      spawner: () => proc,
    });
    expect(killCalls).toHaveLength(0);
    expect(result).toEqual({ stdout: "hello", stderr: "", exitCode: 0 });
  });

  test("SIGTERM fires when timeout expires", async () => {
    const killCalls: Array<number | undefined> = [];
    let resolveExited!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExited = resolve;
    });
    const proc: ProcessHandle = {
      kill(signal?: number) {
        killCalls.push(signal);
        if (signal === undefined) resolveExited(143);
      },
      stdout: makeStream(),
      stderr: makeStream(),
      exited,
    };
    await spawnWithTimeout(
      ["sleep", "100"],
      { timeoutMs: 10 },
      {
        spawner: () => proc,
        sigkillDelayMs: 200,
      },
    );
    expect(killCalls).toContain(undefined);
    expect(killCalls).not.toContain(9);
  });

  test("SIGKILL fires if process ignores SIGTERM", async () => {
    const killCalls: Array<number | undefined> = [];
    let resolveExited!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExited = resolve;
    });
    const proc: ProcessHandle = {
      kill(signal?: number) {
        killCalls.push(signal);
        if (signal === 9) resolveExited(137);
        // SIGTERM is ignored — process stays alive
      },
      stdout: makeStream(),
      stderr: makeStream(),
      exited,
    };
    await spawnWithTimeout(
      ["sleep", "100"],
      { timeoutMs: 10 },
      {
        spawner: () => proc,
        sigkillDelayMs: 50,
      },
    );
    expect(killCalls).toEqual([undefined, 9]);
  });

  test("timeout cleared on normal exit — no spurious kill", async () => {
    const killCalls: Array<number | undefined> = [];
    const proc: ProcessHandle = {
      kill(signal?: number) {
        killCalls.push(signal);
      },
      stdout: makeStream("output"),
      stderr: makeStream(),
      exited: Promise.resolve(0),
    };
    const result = await spawnWithTimeout(
      ["true"],
      { timeoutMs: 10_000 },
      {
        spawner: () => proc,
        sigkillDelayMs: 50,
      },
    );
    expect(killCalls).toHaveLength(0);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("output");
  });
});
