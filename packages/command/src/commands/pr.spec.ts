import { describe, expect, test } from "bun:test";
import type { PrDeps } from "./pr";
import { cmdPr, parsePrMergeArgs, prMerge } from "./pr";

class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`exit(${code})`);
    this.code = code;
  }
}

function makeDeps(overrides: Partial<PrDeps> = {}): PrDeps {
  return {
    exec: () => ({ stdout: "", stderr: "", exitCode: 0 }),
    printError: () => {},
    exit: (code) => {
      throw new ExitError(code);
    },
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}

// ── parsePrMergeArgs ──

describe("parsePrMergeArgs", () => {
  test("parses PR number", () => {
    const r = parsePrMergeArgs(["42"]);
    expect(r.prNumber).toBe("42");
    expect(r.squash).toBe(true); // default
    expect(r.auto).toBe(false);
    expect(r.wait).toBe(false);
    expect(r.error).toBeUndefined();
  });

  test("defaults to squash when no strategy given", () => {
    const r = parsePrMergeArgs(["1"]);
    expect(r.squash).toBe(true);
    expect(r.rebase).toBe(false);
    expect(r.mergeCommit).toBe(false);
  });

  test("parses --rebase", () => {
    const r = parsePrMergeArgs(["1", "--rebase"]);
    expect(r.squash).toBe(false);
    expect(r.rebase).toBe(true);
  });

  test("parses --merge", () => {
    const r = parsePrMergeArgs(["1", "--merge"]);
    expect(r.squash).toBe(false);
    expect(r.mergeCommit).toBe(true);
  });

  test("parses --auto", () => {
    const r = parsePrMergeArgs(["1", "--auto"]);
    expect(r.auto).toBe(true);
  });

  test("parses --wait", () => {
    const r = parsePrMergeArgs(["1", "--wait"]);
    expect(r.wait).toBe(true);
  });

  test("parses --timeout", () => {
    const r = parsePrMergeArgs(["1", "--timeout", "60000"]);
    expect(r.timeout).toBe(60000);
  });

  test("errors when no PR number", () => {
    const r = parsePrMergeArgs([]);
    expect(r.error).toMatch(/Usage/);
  });

  test("errors on invalid timeout", () => {
    const r = parsePrMergeArgs(["1", "--timeout", "notanumber"]);
    expect(r.error).toMatch(/number/);
  });
});

// ── prMerge ──

describe("prMerge", () => {
  test("calls gh pr merge with --squash, no --delete-branch", async () => {
    const calls: string[][] = [];
    const deps = makeDeps({
      exec: (cmd) => {
        calls.push(cmd);
        return { stdout: "✓ Merged", stderr: "", exitCode: 0 };
      },
    });
    await prMerge(["123"], deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("gh");
    expect(calls[0]).toContain("pr");
    expect(calls[0]).toContain("merge");
    expect(calls[0]).toContain("123");
    expect(calls[0]).toContain("--squash");
    expect(calls[0]).not.toContain("--delete-branch");
  });

  test("passes --auto when requested", async () => {
    const calls: string[][] = [];
    const deps = makeDeps({
      exec: (cmd) => {
        calls.push(cmd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    await prMerge(["5", "--auto"], deps);
    expect(calls[0]).toContain("--auto");
  });

  test("never passes --delete-branch even with --auto", async () => {
    const calls: string[][] = [];
    const deps = makeDeps({
      exec: (cmd) => {
        calls.push(cmd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    await prMerge(["5", "--auto"], deps);
    expect(calls[0]).not.toContain("--delete-branch");
  });

  test("exits with gh error code on failure", async () => {
    const errors: string[] = [];
    const deps = makeDeps({
      exec: () => ({ stdout: "", stderr: "PR already merged", exitCode: 1 }),
      printError: (m) => errors.push(m),
    });
    await expect(prMerge(["1"], deps)).rejects.toBeInstanceOf(ExitError);
    expect(errors[0]).toContain("PR already merged");
  });

  test("exits with usage error when no PR number given", async () => {
    const errors: string[] = [];
    const deps = makeDeps({ printError: (m) => errors.push(m) });
    await expect(prMerge([], deps)).rejects.toBeInstanceOf(ExitError);
    expect(errors[0]).toMatch(/Usage/);
  });

  test("--wait polls until MERGED", async () => {
    let calls = 0;
    const deps = makeDeps({
      exec: (cmd) => {
        calls++;
        if (cmd.includes("view")) {
          // Return MERGED on second poll
          return { stdout: calls >= 3 ? "MERGED" : "OPEN", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    await prMerge(["7", "--auto", "--wait", "--timeout", "30000"], deps);
    // Should have called merge once + polled until MERGED
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  test("--wait times out gracefully", async () => {
    const stderrLines: string[] = [];
    const origError = console.error;
    console.error = (m: string) => stderrLines.push(m);
    try {
      const deps = makeDeps({
        exec: (cmd) => {
          if (cmd.includes("view")) return { stdout: "OPEN", stderr: "", exitCode: 0 };
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });
      await prMerge(["9", "--wait", "--timeout", "100"], deps);
      // Should NOT throw — timeout is a graceful exit, not an error
      expect(stderrLines.some((e) => e.includes("timed out"))).toBe(true);
    } finally {
      console.error = origError;
    }
  });
});

// ── cmdPr ──

describe("cmdPr", () => {
  test("prints usage with no args", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (m: string) => logs.push(m);
    try {
      await cmdPr([]);
      expect(logs.join("")).toContain("mcx pr");
    } finally {
      console.log = origLog;
    }
  });

  test("routes to prMerge on 'merge' subcommand", async () => {
    const calls: string[][] = [];
    const deps = makeDeps({
      exec: (cmd) => {
        calls.push(cmd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    await cmdPr(["merge", "42"], deps);
    expect(calls[0]).toContain("42");
  });

  test("exits on unknown subcommand", async () => {
    const errors: string[] = [];
    const deps = makeDeps({ printError: (m) => errors.push(m) });
    await expect(cmdPr(["frobnicate"], deps)).rejects.toBeInstanceOf(ExitError);
    expect(errors[0]).toContain("Unknown pr subcommand");
  });
});
