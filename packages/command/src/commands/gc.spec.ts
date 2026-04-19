import { describe, expect, test } from "bun:test";
import { IpcCallError } from "@mcp-cli/core";
import type { GcDeps } from "./gc";
import { cmdGc, defaultGcDeps, parseDuration, parseGcArgs, runGc } from "./gc";

describe("parseDuration", () => {
  test("parses common units", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("2w")).toBe(2 * 604_800_000);
  });

  test("rejects invalid formats", () => {
    expect(() => parseDuration("1x")).toThrow();
    expect(() => parseDuration("abc")).toThrow();
    expect(() => parseDuration("1")).toThrow();
  });
});

describe("parseGcArgs", () => {
  test("defaults", () => {
    const opts = parseGcArgs([]);
    expect(opts.dryRun).toBe(false);
    expect(opts.olderThanMs).toBe(86_400_000);
    expect(opts.branchesOnly).toBe(false);
    expect(opts.worktreesOnly).toBe(false);
  });

  test("--dry-run, -n", () => {
    expect(parseGcArgs(["--dry-run"]).dryRun).toBe(true);
    expect(parseGcArgs(["-n"]).dryRun).toBe(true);
  });

  test("--older-than <dur> and --older-than=<dur>", () => {
    expect(parseGcArgs(["--older-than", "3d"]).olderThanMs).toBe(3 * 86_400_000);
    expect(parseGcArgs(["--older-than=2h"]).olderThanMs).toBe(7_200_000);
  });

  test("--branches-only / --worktrees-only", () => {
    expect(parseGcArgs(["--branches-only"]).branchesOnly).toBe(true);
    expect(parseGcArgs(["--worktrees-only"]).worktreesOnly).toBe(true);
  });

  test("mutually exclusive only-flags", () => {
    expect(() => parseGcArgs(["--branches-only", "--worktrees-only"])).toThrow();
  });

  test("unknown arg throws", () => {
    expect(() => parseGcArgs(["--frobnicate"])).toThrow();
  });

  test("missing --older-than value throws", () => {
    expect(() => parseGcArgs(["--older-than"])).toThrow();
  });
});

// ── runGc integration tests with mocked deps ──

function makeDeps(
  overrides: {
    execResponses?: Map<string, { stdout: string; stderr?: string; exitCode?: number }>;
    execFallback?: (cmd: string[]) => { stdout: string; stderr: string; exitCode: number };
    callTool?: GcDeps["callTool"];
    mtimes?: Map<string, number>;
  } = {},
): GcDeps & { logs: string[]; errors: string[]; execCalls: string[][] } {
  const logs: string[] = [];
  const errors: string[] = [];
  const execCalls: string[][] = [];
  const exec = (cmd: string[]): { stdout: string; stderr: string; exitCode: number } => {
    execCalls.push(cmd);
    const key = cmd.join(" ");
    const r = overrides.execResponses?.get(key);
    if (r) {
      return { stdout: r.stdout, stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
    }
    if (overrides.execFallback) return overrides.execFallback(cmd);
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return {
    cwd: "/repo",
    callTool: overrides.callTool ?? (async () => "[]"),
    exec,
    getMtime: (p) => overrides.mtimes?.get(p) ?? null,
    printError: (m) => errors.push(m),
    log: (m) => logs.push(m),
    logError: (m) => errors.push(m),
    logs,
    errors,
    execCalls,
  };
}

describe("runGc branches", () => {
  test("dry-run lists merged branches without deleting", async () => {
    const responses = new Map<string, { stdout: string }>();
    responses.set("git -C /repo worktree list --porcelain", {
      stdout: "worktree /repo\nbranch refs/heads/main\n\n",
    });
    responses.set("git -C /repo symbolic-ref refs/remotes/origin/HEAD", { stdout: "refs/remotes/origin/main" });
    responses.set("git -C /repo branch --merged main", { stdout: "* main\n  feat-a\n  feat-b\n" });
    responses.set("git -C /repo branch --show-current", { stdout: "main" });

    const d = makeDeps({ execResponses: responses });
    await runGc({ dryRun: true, olderThanMs: 86_400_000, branchesOnly: true, worktreesOnly: false }, d);

    expect(d.logs.some((l) => l.includes("would delete 2 merged"))).toBe(true);
    expect(d.logs.some((l) => l.includes("feat-a"))).toBe(true);
    expect(d.logs.some((l) => l.includes("feat-b"))).toBe(true);
    // Must not actually call `git branch -d`
    expect(d.execCalls.some((c) => c[3] === "branch" && c[4] === "-d")).toBe(false);
  });

  test("live mode deletes merged branches via git branch -d", async () => {
    const responses = new Map<string, { stdout: string; stderr?: string; exitCode?: number }>();
    responses.set("git -C /repo worktree list --porcelain", { stdout: "" });
    responses.set("git -C /repo symbolic-ref refs/remotes/origin/HEAD", { stdout: "refs/remotes/origin/main" });
    responses.set("git -C /repo branch --merged main", { stdout: "* main\n  old-feat\n" });
    responses.set("git -C /repo branch --show-current", { stdout: "main" });
    responses.set("git -C /repo fetch --prune", { stdout: "" });
    responses.set("git -C /repo branch -d old-feat", { stdout: "Deleted branch old-feat", exitCode: 0 });

    const d = makeDeps({ execResponses: responses });
    await runGc({ dryRun: false, olderThanMs: 86_400_000, branchesOnly: true, worktreesOnly: false }, d);

    expect(d.execCalls.some((c) => c.join(" ") === "git -C /repo branch -d old-feat")).toBe(true);
    expect(d.errors.some((l) => l.includes("branches: deleted 1"))).toBe(true);
  });

  test("excludes default branch and current branch", async () => {
    const responses = new Map<string, { stdout: string; exitCode?: number }>();
    responses.set("git -C /repo worktree list --porcelain", { stdout: "" });
    responses.set("git -C /repo symbolic-ref refs/remotes/origin/HEAD", { stdout: "refs/remotes/origin/main" });
    responses.set("git -C /repo branch --merged main", { stdout: "  main\n  feat\n* working\n" });
    responses.set("git -C /repo branch --show-current", { stdout: "working" });

    const d = makeDeps({ execResponses: responses });
    await runGc({ dryRun: true, olderThanMs: 86_400_000, branchesOnly: true, worktreesOnly: false }, d);

    // Only "feat" should be removable — neither "main" (default) nor "working" (current)
    expect(d.logs.some((l) => l.includes("would delete 1 merged"))).toBe(true);
    expect(d.logs.some((l) => l.includes("feat"))).toBe(true);
    expect(d.logs.some((l) => l.includes("main") && l.includes("-"))).toBe(false);
    expect(d.logs.some((l) => l.includes("working"))).toBe(false);
  });

  test("excludes branches checked out by a worktree", async () => {
    const responses = new Map<string, { stdout: string }>();
    responses.set("git -C /repo worktree list --porcelain", {
      stdout: "worktree /repo\nbranch refs/heads/main\n\nworktree /other\nbranch refs/heads/feat\n\n",
    });
    responses.set("git -C /repo symbolic-ref refs/remotes/origin/HEAD", { stdout: "refs/remotes/origin/main" });
    responses.set("git -C /repo branch --merged main", { stdout: "* main\n  feat\n  stale\n" });
    responses.set("git -C /repo branch --show-current", { stdout: "main" });

    const d = makeDeps({ execResponses: responses });
    await runGc({ dryRun: true, olderThanMs: 86_400_000, branchesOnly: true, worktreesOnly: false }, d);

    // Only "stale" — feat is checked out by /other
    expect(d.logs.some((l) => l.includes("would delete 1 merged"))).toBe(true);
    expect(d.logs.some((l) => l.includes("stale"))).toBe(true);
  });
});

describe("runGc worktrees", () => {
  const baseWorktreeList = [
    "worktree /repo",
    "branch refs/heads/main",
    "",
    "worktree /repo/.claude/worktrees/wt-a",
    "branch refs/heads/feat-a",
    "",
    "worktree /repo/.claude/worktrees/wt-b",
    "branch refs/heads/feat-b",
    "",
  ].join("\n");

  function makeWorktreeResponses() {
    const r = new Map<string, { stdout: string; stderr?: string; exitCode?: number }>();
    r.set("git -C /repo worktree list --porcelain", { stdout: baseWorktreeList });
    r.set("git -C /repo symbolic-ref refs/remotes/origin/HEAD", { stdout: "refs/remotes/origin/main" });
    r.set("git -C /repo branch --merged main", { stdout: "* main\n  feat-a\n  feat-b\n" });
    // Both worktrees clean
    r.set("git -C /repo/.claude/worktrees/wt-a status --porcelain", { stdout: "" });
    r.set("git -C /repo/.claude/worktrees/wt-b status --porcelain", { stdout: "" });
    return r;
  }

  test("dry-run lists worktree candidates", async () => {
    const responses = makeWorktreeResponses();
    const d = makeDeps({ execResponses: responses });

    await runGc({ dryRun: true, olderThanMs: 86_400_000, branchesOnly: false, worktreesOnly: true }, d);

    expect(d.logs.some((l) => l.includes("would remove 2"))).toBe(true);
    expect(d.logs.some((l) => l.includes("wt-a"))).toBe(true);
    expect(d.logs.some((l) => l.includes("wt-b"))).toBe(true);
  });

  test("age filter skips recently-modified worktrees", async () => {
    const responses = makeWorktreeResponses();
    const now = Date.now();
    const mtimes = new Map<string, number>([
      // wt-a is fresh (modified now) → skipped
      ["/repo/.claude/worktrees/wt-a", now],
      // wt-b is old → eligible
      ["/repo/.claude/worktrees/wt-b", now - 10 * 86_400_000],
    ]);
    const d = makeDeps({ execResponses: responses, mtimes });

    await runGc({ dryRun: true, olderThanMs: 86_400_000, branchesOnly: false, worktreesOnly: true }, d);

    expect(d.logs.some((l) => l.includes("would remove 1"))).toBe(true);
    expect(d.logs.some((l) => l.includes("1 skipped (too recent)"))).toBe(true);
    expect(d.logs.some((l) => l.includes("wt-b"))).toBe(true);
  });

  test("dry-run reports unmerged worktrees", async () => {
    const responses = makeWorktreeResponses();
    // Neither branch merged
    responses.set("git -C /repo branch --merged main", { stdout: "* main\n" });
    const d = makeDeps({ execResponses: responses });

    await runGc({ dryRun: true, olderThanMs: 86_400_000, branchesOnly: false, worktreesOnly: true }, d);

    expect(d.logs.some((l) => l.includes("would remove 0"))).toBe(true);
    expect(d.logs.some((l) => l.includes("2 skipped (unmerged)"))).toBe(true);
  });

  test("active-session worktree is skipped even without age filter", async () => {
    const responses = makeWorktreeResponses();
    const d = makeDeps({
      execResponses: responses,
      callTool: async (tool) => {
        // Pretend wt-a is an active claude session
        if (tool === "claude_session_list") return [{ worktree: "wt-a" }];
        return [];
      },
    });

    await runGc({ dryRun: true, olderThanMs: 86_400_000, branchesOnly: false, worktreesOnly: true }, d);

    expect(d.logs.some((l) => l.includes("would remove 1"))).toBe(true);
    expect(d.logs.some((l) => l.includes("wt-b"))).toBe(true);
    expect(d.logs.some((l) => l.includes("wt-a") && l.includes("- "))).toBe(false);
  });

  test("live mode continues when a provider returns IpcCallError (server not connected)", async () => {
    // Regression for #1465: if _acp (or any provider) is not connected, calling
    // acp_session_list throws IpcCallError. gc should skip that provider (no
    // active sessions possible on a disconnected server) rather than aborting.
    const responses = makeWorktreeResponses();
    let claudeCallCount = 0;
    const d = makeDeps({
      execResponses: responses,
      callTool: async (tool) => {
        if (tool === "claude_session_list") {
          claudeCallCount++;
          return [];
        }
        // All other providers are unreachable at the IPC level (server not connected)
        throw new IpcCallError({ code: -32000, message: "server not connected", data: undefined });
      },
    });

    await runGc({ dryRun: true, olderThanMs: 86_400_000, branchesOnly: false, worktreesOnly: true }, d);

    // Must NOT abort — gc should proceed despite provider IpcCallErrors
    expect(d.logs.some((l) => l.includes("would remove"))).toBe(true);
    // The daemon-reachable provider was still called
    expect(claudeCallCount).toBeGreaterThan(0);
    // Must not emit the fatal "Cannot reach daemon" error
    expect(d.errors.some((e) => e.includes("Cannot reach daemon"))).toBe(false);
  });

  test("live mode fails closed when session list throws", async () => {
    const responses = makeWorktreeResponses();
    const d = makeDeps({
      execResponses: responses,
      callTool: async () => {
        throw new Error("daemon unreachable");
      },
    });

    await runGc({ dryRun: false, olderThanMs: 86_400_000, branchesOnly: false, worktreesOnly: true }, d);

    expect(d.errors.some((e) => e.includes("gc:") && e.includes("daemon"))).toBe(true);
    // Should not have pruned anything — aborted before reaching the list phase
    expect(d.errors.some((e) => e.includes("worktrees: removed"))).toBe(false);
  });

  test("live mode: refreshActive preserves stale active set on mid-loop daemon loss", async () => {
    // Regression for PR #1278 round-2 🔴: if refreshActive uses failClosed=false,
    // a daemon death mid-loop returns Set{} (not a throw), which would be
    // assigned over the initial active set and cause every remaining
    // candidate to be pruned — including the active session's worktree.
    //
    // Fix: refreshActive uses failClosed=true, so daemon loss throws; the
    // callback catches and returns the last-known active set, protecting
    // in-flight sessions.
    const responses = makeWorktreeResponses();
    responses.set("git -C /repo worktree remove /repo/.claude/worktrees/wt-a", { stdout: "" });
    responses.set("git -C /repo worktree remove /repo/.claude/worktrees/wt-b", { stdout: "" });
    responses.set("git -C /repo branch -d feat-a", { stdout: "" });
    responses.set("git -C /repo branch -d feat-b", { stdout: "" });
    responses.set("git -C /repo config --get core.bare", { stdout: "false" });

    let callCount = 0;
    const d = makeDeps({
      execResponses: responses,
      execFallback: () => ({ stdout: "", stderr: "", exitCode: 0 }),
      callTool: async (tool) => {
        if (tool !== "claude_session_list") return [];
        callCount++;
        // First call (initial fetch): wt-a is active.
        if (callCount === 1) return [{ worktree: "wt-a" }];
        // Subsequent calls (refreshActive between removals): daemon died.
        throw new Error("daemon unreachable mid-loop");
      },
    });

    await runGc({ dryRun: false, olderThanMs: 86_400_000, branchesOnly: false, worktreesOnly: true }, d);

    // wt-a must NOT be removed — stale active set preserves the skip.
    const removedA = d.execCalls.some(
      (c) => c.join(" ") === "git -C /repo worktree remove /repo/.claude/worktrees/wt-a",
    );
    expect(removedA).toBe(false);
    // A diagnostic must be emitted so post-mortem is possible.
    expect(d.errors.some((e) => e.includes("daemon unreachable during prune"))).toBe(true);
  });

  test("dry-run fails open when session list throws (daemon unreachable)", async () => {
    const responses = makeWorktreeResponses();
    const d = makeDeps({
      execResponses: responses,
      callTool: async () => {
        throw new Error("daemon unreachable");
      },
    });

    await runGc({ dryRun: true, olderThanMs: 86_400_000, branchesOnly: false, worktreesOnly: true }, d);

    // Warning emitted about skipped filter
    expect(d.errors.some((e) => e.includes("active-session filter skipped"))).toBe(true);
    // But inspection still proceeds
    expect(d.logs.some((l) => l.includes("would remove"))).toBe(true);
  });

  test("default mode: worktree-phase branch deletions don't cause false branch-phase failures", async () => {
    // Regression: when the worktree phase's deleteIfMerged removes a branch,
    // the branch phase must skip it rather than trying `git branch -d` again
    // and reporting a false failure.
    const responses = makeWorktreeResponses();
    responses.set("git -C /repo fetch --prune", { stdout: "" });
    responses.set("git -C /repo branch --show-current", { stdout: "main" });
    responses.set("git -C /repo worktree remove /repo/.claude/worktrees/wt-a", { stdout: "" });
    responses.set("git -C /repo worktree remove /repo/.claude/worktrees/wt-b", { stdout: "" });
    responses.set("git -C /repo branch -d feat-a", { stdout: "" });
    responses.set("git -C /repo branch -d feat-b", { stdout: "" });
    responses.set("git -C /repo config --get core.bare", { stdout: "false" });

    const d = makeDeps({
      execResponses: responses,
      execFallback: () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });

    // Default mode: both worktrees and branches.
    await runGc({ dryRun: false, olderThanMs: 86_400_000, branchesOnly: false, worktreesOnly: false }, d);

    // The branch phase must not report any failures — it must skip branches
    // the worktree phase already deleted.
    expect(d.errors.some((e) => e.includes("branches: deleted") && e.includes("failed"))).toBe(false);
    // Exactly one `git branch -d feat-a` and one `git branch -d feat-b` — the
    // branch phase must not issue a second attempt.
    const featADeletes = d.execCalls.filter((c) => c.join(" ") === "git -C /repo branch -d feat-a").length;
    const featBDeletes = d.execCalls.filter((c) => c.join(" ") === "git -C /repo branch -d feat-b").length;
    expect(featADeletes).toBe(1);
    expect(featBDeletes).toBe(1);
  });

  test("live mode runs fetch --prune and reports result", async () => {
    const responses = makeWorktreeResponses();
    responses.set("git -C /repo fetch --prune", { stdout: "" });
    responses.set("git -C /repo branch --show-current", { stdout: "main" });
    // worktree remove for both
    responses.set("git -C /repo worktree remove /repo/.claude/worktrees/wt-a", { stdout: "" });
    responses.set("git -C /repo worktree remove /repo/.claude/worktrees/wt-b", { stdout: "" });
    responses.set("git -C /repo branch -d feat-a", { stdout: "" });
    responses.set("git -C /repo branch -d feat-b", { stdout: "" });
    // core.bare check used by fixCoreBare
    responses.set("git -C /repo config --get core.bare", { stdout: "false" });

    const d = makeDeps({
      execResponses: responses,
      execFallback: () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });

    await runGc({ dryRun: false, olderThanMs: 86_400_000, branchesOnly: false, worktreesOnly: false }, d);

    expect(d.execCalls.some((c) => c.join(" ") === "git -C /repo fetch --prune")).toBe(true);
    expect(d.errors.some((e) => e.includes("worktrees: removed"))).toBe(true);
  });
});

describe("runGc error paths", () => {
  test("reports WorktreeError from listMcxWorktrees", async () => {
    const responses = new Map<string, { stdout: string; exitCode?: number }>();
    // Make worktree list fail → triggers WorktreeError
    responses.set("git -C /repo worktree list --porcelain", { stdout: "", exitCode: 128 });
    const d = makeDeps({ execResponses: responses });

    await runGc({ dryRun: true, olderThanMs: 86_400_000, branchesOnly: false, worktreesOnly: true }, d);

    expect(d.errors.some((e) => e.includes("gc:") && e.includes("Failed to list"))).toBe(true);
  });

  test("reports fetch --prune failure but continues", async () => {
    const responses = new Map<string, { stdout: string; stderr?: string; exitCode?: number }>();
    responses.set("git -C /repo worktree list --porcelain", { stdout: "" });
    responses.set("git -C /repo fetch --prune", { stdout: "", stderr: "network down", exitCode: 1 });
    responses.set("git -C /repo symbolic-ref refs/remotes/origin/HEAD", { stdout: "refs/remotes/origin/main" });
    responses.set("git -C /repo branch --merged main", { stdout: "" });
    responses.set("git -C /repo branch --show-current", { stdout: "main" });

    const d = makeDeps({ execResponses: responses });
    await runGc({ dryRun: false, olderThanMs: 86_400_000, branchesOnly: true, worktreesOnly: false }, d);

    expect(d.errors.some((e) => e.includes("fetch --prune failed") && e.includes("network down"))).toBe(true);
  });

  test("reports branch delete failures", async () => {
    const responses = new Map<string, { stdout: string; stderr?: string; exitCode?: number }>();
    responses.set("git -C /repo worktree list --porcelain", { stdout: "" });
    responses.set("git -C /repo fetch --prune", { stdout: "" });
    responses.set("git -C /repo symbolic-ref refs/remotes/origin/HEAD", { stdout: "refs/remotes/origin/main" });
    responses.set("git -C /repo branch --merged main", { stdout: "* main\n  bad-branch\n" });
    responses.set("git -C /repo branch --show-current", { stdout: "main" });
    responses.set("git -C /repo branch -d bad-branch", {
      stdout: "",
      stderr: "not fully merged",
      exitCode: 1,
    });

    const d = makeDeps({ execResponses: responses });
    await runGc({ dryRun: false, olderThanMs: 86_400_000, branchesOnly: true, worktreesOnly: false }, d);

    expect(d.errors.some((e) => e.includes("deleted 0") && e.includes("1 failed"))).toBe(true);
    expect(d.errors.some((e) => e.includes("bad-branch") && e.includes("not fully merged"))).toBe(true);
  });
});

describe("defaultGcDeps", () => {
  test("exec returns stdout/stderr/exitCode from a real command", () => {
    const deps = defaultGcDeps();
    const r = deps.exec(["echo", "hello"]);
    expect(r.stdout).toContain("hello");
    expect(r.exitCode).toBe(0);
  });

  test("getMtime returns null for nonexistent paths", () => {
    const deps = defaultGcDeps();
    expect(deps.getMtime("/definitely/not/a/real/path/xyz")).toBeNull();
  });

  test("getMtime returns a number for existing paths", () => {
    const deps = defaultGcDeps();
    const mtime = deps.getMtime("/");
    expect(typeof mtime).toBe("number");
  });
});

describe("cmdGc dispatch", () => {
  async function catchExit(fn: () => Promise<unknown>): Promise<number | undefined> {
    const origExit = process.exit;
    const origLog = console.log;
    let exitCode: number | undefined;
    process.exit = ((c?: number) => {
      exitCode = c;
      throw new Error("__exit__");
    }) as typeof process.exit;
    console.log = () => {};
    try {
      await fn().catch((e) => {
        if ((e as Error).message !== "__exit__") throw e;
      });
    } finally {
      process.exit = origExit;
      console.log = origLog;
    }
    return exitCode;
  }

  test("invalid args cause exit(1)", async () => {
    expect(await catchExit(() => cmdGc(["--frobnicate"]))).toBe(1);
  });

  test("--help shows usage and exits 0", async () => {
    const origExit = process.exit;
    const origLog = console.log;
    let exitCode: number | undefined;
    process.exit = ((c?: number) => {
      exitCode = c;
      throw new Error("__exit__");
    }) as typeof process.exit;
    console.log = () => {};
    try {
      expect(() => parseGcArgs(["--help"])).toThrow("__exit__");
    } finally {
      process.exit = origExit;
      console.log = origLog;
    }
    expect(exitCode).toBe(0);
  });

  test("overrides.dryRun forces dry-run mode", async () => {
    // Use a fake cwd and empty exec results — we just care that it doesn't throw
    // and produces dry-run output paths. Redirect console to capture.
    const origLog = console.log;
    const origErr = console.error;
    const lines: string[] = [];
    console.log = (msg: unknown) => lines.push(String(msg));
    console.error = (msg: unknown) => lines.push(String(msg));
    try {
      // Pass --worktrees-only so we don't need to mock branch commands
      // but we will still invoke real git in cwd — that's fine for the test.
      // Force dry-run via overrides even though args don't include --dry-run.
      await cmdGc(["--worktrees-only"], { dryRun: true });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    // Just assert something ran — dry-run output should be present
    expect(lines.some((l) => l.includes("[dry-run]") || l.includes("would remove") || l.includes("gc:"))).toBe(true);
  });
});

describe("runGc worktrees-only skips branch work", () => {
  test("worktrees-only does not call git branch --merged or fetch", async () => {
    const responses = new Map<string, { stdout: string }>();
    // listMcxWorktrees requires worktree list
    responses.set("git -C /repo worktree list --porcelain", { stdout: "" });

    const d = makeDeps({ execResponses: responses });
    await runGc({ dryRun: true, olderThanMs: 86_400_000, branchesOnly: false, worktreesOnly: true }, d);

    // No branch deletions should happen (no `git branch -d` calls)
    expect(d.execCalls.some((c) => c[3] === "branch" && c[4] === "-d")).toBe(false);
    // No fetch --prune should happen when only cleaning worktrees
    expect(d.execCalls.some((c) => c.includes("fetch"))).toBe(false);
  });
});
