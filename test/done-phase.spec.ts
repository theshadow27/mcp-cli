import { describe, expect, test } from "bun:test";
import { type MergePrDeps, mergePr } from "../.claude/phases/done-fn";
import type { GhResult } from "../.claude/phases/gh";

function ok(stdout = ""): GhResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr = "oops", exitCode = 1): GhResult {
  return { stdout: "", stderr, exitCode };
}

function makeDeps(overrides: Partial<MergePrDeps> = {}): MergePrDeps {
  return {
    gh: async (args) => {
      // Default: labels returns qa:pass, CI returns 0 ungreen checks
      if (args.includes("labels")) return ok("qa:pass");
      if (args.includes("statusCheckRollup")) return ok("0");
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
        gh: async (args) => {
          if (args.includes("labels")) return ok("needs-review");
          return ok("0");
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "missing_qa_pass" });
    if (!result.ok) expect(result.nextAction).toContain("spawn qa");
  });

  test("both qa:pass and qa:fail → missing_qa_pass (stale label)", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        gh: async (args) => {
          if (args.includes("labels")) return ok("qa:pass\nqa:fail");
          return ok("0");
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "missing_qa_pass" });
    if (!result.ok) expect(result.nextAction).toContain("stale label");
  });

  test("gh labels call fails → merge_failed", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        gh: async (args) => {
          if (args.includes("labels")) return fail("auth required");
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
        gh: async (args) => {
          if (args.includes("labels")) return ok("qa:pass");
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
        gh: async (args) => {
          if (args.includes("labels")) return ok("qa:pass");
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
        gh: async (args) => {
          if (args.includes("labels")) return ok("qa:pass");
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

  test("spawn called to reset core.bare before merge", async () => {
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
    expect(spawnCalls[0]).toEqual(["git", "config", "core.bare", "false"]);
  });
});

// ── Merge failure classification ──

describe("mergePr — merge failure paths", () => {
  test("conflict error → conflicts", async () => {
    const result = await mergePr(100, makeDeps({ prMerge: async () => fail("Pull Request is not mergeable") }));
    expect(result).toMatchObject({ ok: false, reason: "conflicts" });
    if (!result.ok) expect(result.detail).toContain("not mergeable");
  });

  test("'conflict' keyword → conflicts", async () => {
    const result = await mergePr(100, makeDeps({ prMerge: async () => fail("merge conflict detected") }));
    expect(result).toMatchObject({ ok: false, reason: "conflicts" });
  });

  test("required check error → missing_required_check", async () => {
    const result = await mergePr(100, makeDeps({ prMerge: async () => fail("required check 'CI' has not passed") }));
    expect(result).toMatchObject({ ok: false, reason: "missing_required_check" });
  });

  test("required status error → missing_required_check", async () => {
    const result = await mergePr(100, makeDeps({ prMerge: async () => fail("Required status check not passing") }));
    expect(result).toMatchObject({ ok: false, reason: "missing_required_check" });
  });

  test("generic failure → merge_failed", async () => {
    const result = await mergePr(100, makeDeps({ prMerge: async () => fail("something unexpected") }));
    expect(result).toMatchObject({ ok: false, reason: "merge_failed" });
  });

  test("SIGTERM exit code (143) → check PR state, if MERGED → ok", async () => {
    const result = await mergePr(
      100,
      makeDeps({
        prMerge: async () => ({ stdout: "", stderr: "killed", exitCode: 143 }),
        prView: async () => "MERGED",
      }),
    );
    // exitCode >= 128 triggers the maybeSucceeded path which always sets localCleanup
    expect(result).toMatchObject({ ok: true, prNumber: 100 });
    if (result.ok) expect(result.localCleanup).toContain("worktree");
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
  test("gh calls happen in parallel (both args captured)", async () => {
    const capturedArgs: string[][] = [];
    await mergePr(
      100,
      makeDeps({
        gh: async (args) => {
          capturedArgs.push(args);
          if (args.includes("labels")) return ok("qa:pass");
          return ok("0");
        },
      }),
    );
    // Both calls should have occurred
    const hasLabels = capturedArgs.some((a) => a.includes("labels"));
    const hasCi = capturedArgs.some((a) => a.includes("statusCheckRollup"));
    expect(hasLabels).toBe(true);
    expect(hasCi).toBe(true);
  });
});
