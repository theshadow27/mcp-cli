import { describe, expect, test } from "bun:test";
import type { PrThreadSnapshot } from "@mcp-cli/core";
import type { PrDeps } from "./pr";
import {
  cmdPr,
  formatSnapshotXml,
  parsePrCommentsArgs,
  parsePrMergeArgs,
  parsePrResolveArgs,
  parsePrWaitArgs,
  prComments,
  prCommentsResolve,
  prMerge,
  prWaitForCopilot,
} from "./pr";

class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`exit(${code})`);
    this.code = code;
  }
}

const emptySnapshot: PrThreadSnapshot = {
  threads: [],
  reviews: [],
  topLevelComments: [],
  fetchedAt: "2026-05-23T00:00:00.000Z",
  pushedAt: null,
  truncated: false,
};

function neverStream() {
  return {
    events: (async function* () {
      // Never yields — simulates no events arriving
    })(),
    abort: () => {},
  };
}

function makeDeps(overrides: Partial<PrDeps> = {}): PrDeps {
  return {
    exec: () => ({ stdout: "", stderr: "", exitCode: 0 }),
    printError: () => {},
    exit: (code) => {
      throw new ExitError(code);
    },
    sleep: () => Promise.resolve(),
    ipcCall: (() => Promise.resolve(emptySnapshot)) as PrDeps["ipcCall"],
    repoRoot: () => "/tmp/test-repo",
    openStream: neverStream,
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

// ── parsePrCommentsArgs ──

describe("parsePrCommentsArgs", () => {
  test("parses PR number", () => {
    const r = parsePrCommentsArgs(["42"]);
    expect(r.prNumber).toBe(42);
    expect(r.json).toBe(false);
    expect(r.includeResolved).toBe(false);
    expect(r.error).toBeUndefined();
  });

  test("parses --json", () => {
    const r = parsePrCommentsArgs(["1", "--json"]);
    expect(r.json).toBe(true);
  });

  test("parses --include-resolved", () => {
    const r = parsePrCommentsArgs(["1", "--include-resolved"]);
    expect(r.includeResolved).toBe(true);
  });

  test("parses all flags together", () => {
    const r = parsePrCommentsArgs(["99", "--json", "--include-resolved"]);
    expect(r.prNumber).toBe(99);
    expect(r.json).toBe(true);
    expect(r.includeResolved).toBe(true);
  });

  test("errors when no PR number", () => {
    const r = parsePrCommentsArgs([]);
    expect(r.error).toMatch(/Usage/);
  });

  test("errors on unknown flag", () => {
    const r = parsePrCommentsArgs(["1", "--unknown"]);
    expect(r.error).toMatch(/Unknown flag/);
  });

  test("errors on invalid PR number", () => {
    const r = parsePrCommentsArgs(["abc"]);
    expect(r.error).toMatch(/Invalid PR number/);
  });
});

// ── parsePrWaitArgs ──

describe("parsePrWaitArgs", () => {
  test("parses PR number with defaults", () => {
    const r = parsePrWaitArgs(["42"]);
    expect(r.prNumber).toBe(42);
    expect(r.maxWaitMs).toBe(600_000);
    expect(r.error).toBeUndefined();
  });

  test("parses --max-wait", () => {
    const r = parsePrWaitArgs(["1", "--max-wait", "300"]);
    expect(r.maxWaitMs).toBe(300_000);
  });

  test("errors when no PR number", () => {
    const r = parsePrWaitArgs([]);
    expect(r.error).toMatch(/Usage/);
  });

  test("errors on invalid --max-wait", () => {
    const r = parsePrWaitArgs(["1", "--max-wait", "abc"]);
    expect(r.error).toMatch(/number/);
  });

  test("errors on missing --max-wait value", () => {
    const r = parsePrWaitArgs(["1", "--max-wait"]);
    expect(r.error).toMatch(/requires a value/);
  });
});

// ── prMerge ──

describe("prMerge", () => {
  test("calls gh pr merge with --squash, no --delete-branch", async () => {
    const calls: string[][] = [];
    const deps = makeDeps({
      exec: (cmd: string[]) => {
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
      exec: (cmd: string[]) => {
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
      exec: (cmd: string[]) => {
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
      printError: (m: string) => errors.push(m),
    });
    await expect(prMerge(["1"], deps)).rejects.toBeInstanceOf(ExitError);
    expect(errors[0]).toContain("PR already merged");
  });

  test("exits with usage error when no PR number given", async () => {
    const errors: string[] = [];
    const deps = makeDeps({ printError: (m: string) => errors.push(m) });
    await expect(prMerge([], deps)).rejects.toBeInstanceOf(ExitError);
    expect(errors[0]).toMatch(/Usage/);
  });

  test("--wait polls until MERGED", async () => {
    let calls = 0;
    const deps = makeDeps({
      exec: (cmd: string[]) => {
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

  test("--wait times out with exit 124", async () => {
    const errors: string[] = [];
    const deps = makeDeps({
      exec: (cmd: string[]) => {
        if (cmd.includes("view")) return { stdout: "OPEN", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      printError: (m: string) => errors.push(m),
    });
    const err = await prMerge(["9", "--wait", "--timeout", "100"], deps).catch((e) => e);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).code).toBe(124);
    expect(errors.some((e: string) => e.includes("timed out"))).toBe(true);
  });

  test("--wait exits immediately on gh pr view failure", async () => {
    const errors: string[] = [];
    const deps = makeDeps({
      exec: (cmd: string[]) => {
        if (cmd.includes("view")) return { stdout: "", stderr: "auth failure", exitCode: 1 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      printError: (m: string) => errors.push(m),
    });
    const err = await prMerge(["1", "--wait"], deps).catch((e) => e);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).code).toBe(1);
    expect(errors.some((e: string) => e.includes("auth failure"))).toBe(true);
  });

  test("--wait exits immediately on gh pr view failure (no stderr)", async () => {
    const errors: string[] = [];
    const deps = makeDeps({
      exec: (cmd: string[]) => {
        if (cmd.includes("view")) return { stdout: "", stderr: "", exitCode: 2 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      printError: (m: string) => errors.push(m),
    });
    const err = await prMerge(["1", "--wait"], deps).catch((e) => e);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).code).toBe(2);
    expect(errors.some((e: string) => e.includes("exited with code 2"))).toBe(true);
  });

  test("--wait exits nonzero when PR is closed", async () => {
    const errors: string[] = [];
    const deps = makeDeps({
      exec: (cmd: string[]) => {
        if (cmd.includes("view")) return { stdout: "CLOSED", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      printError: (m: string) => errors.push(m),
    });
    const err = await prMerge(["11", "--wait", "--timeout", "30000"], deps).catch((e) => e);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).code).toBe(1);
    expect(errors.some((e: string) => e.includes("closed"))).toBe(true);
  });
});

// ── prComments ──

describe("prComments", () => {
  test("calls IPC with correct params", async () => {
    const ipcCalls: Array<{ method: string; params: unknown }> = [];
    const deps = makeDeps({
      ipcCall: ((method: string, params: unknown) => {
        ipcCalls.push({ method, params });
        return Promise.resolve(emptySnapshot);
      }) as PrDeps["ipcCall"],
    });

    const origLog = console.log;
    console.log = (() => {}) as typeof console.log;
    try {
      await prComments(["42"], deps);
    } finally {
      console.log = origLog;
    }

    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0].method).toBe("getPrThreadSnapshot");
    expect(ipcCalls[0].params).toEqual({
      prNumber: 42,
      repoRoot: "/tmp/test-repo",
      includeResolved: false,
    });
  });

  test("passes --include-resolved to IPC", async () => {
    const ipcCalls: Array<{ method: string; params: unknown }> = [];
    const deps = makeDeps({
      ipcCall: ((method: string, params: unknown) => {
        ipcCalls.push({ method, params });
        return Promise.resolve(emptySnapshot);
      }) as PrDeps["ipcCall"],
    });

    const origLog = console.log;
    console.log = (() => {}) as typeof console.log;
    try {
      await prComments(["42", "--include-resolved"], deps);
    } finally {
      console.log = origLog;
    }

    expect((ipcCalls[0].params as Record<string, unknown>).includeResolved).toBe(true);
  });

  test("outputs JSON when --json flag is set", async () => {
    const snapshot: PrThreadSnapshot = {
      ...emptySnapshot,
      threads: [
        {
          threadId: "T1",
          rootCommentId: 100,
          user: "Copilot",
          location: "src/main.ts:10",
          body: "Suggestion",
          resolved: false,
          outdated: false,
          replies: [],
        },
      ],
    };

    const deps = makeDeps({
      ipcCall: (() => Promise.resolve(snapshot)) as PrDeps["ipcCall"],
    });

    const output: string[] = [];
    const origLog = console.log;
    console.log = ((m: string) => output.push(m)) as typeof console.log;
    try {
      await prComments(["1", "--json"], deps);
    } finally {
      console.log = origLog;
    }

    const parsed = JSON.parse(output.join(""));
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.threads[0].user).toBe("Copilot");
  });

  test("outputs XML by default", async () => {
    const deps = makeDeps({
      ipcCall: (() => Promise.resolve(emptySnapshot)) as PrDeps["ipcCall"],
    });

    const output: string[] = [];
    const origLog = console.log;
    console.log = ((m: string) => output.push(m)) as typeof console.log;
    try {
      await prComments(["1"], deps);
    } finally {
      console.log = origLog;
    }

    expect(output.join("")).toContain("<pr-threads");
  });

  test("exits on error", async () => {
    const errors: string[] = [];
    const deps = makeDeps({ printError: (m: string) => errors.push(m) });
    await expect(prComments([], deps)).rejects.toBeInstanceOf(ExitError);
    expect(errors[0]).toMatch(/Usage/);
  });
});

// ── prWaitForCopilot ──

describe("prWaitForCopilot", () => {
  test("exits 0 immediately when Copilot has posted and push is old", async () => {
    const copilotSnapshot: PrThreadSnapshot = {
      ...emptySnapshot,
      pushedAt: new Date(Date.now() - 120_000).toISOString(),
      threads: [
        {
          threadId: "T1",
          rootCommentId: 100,
          user: "Copilot",
          location: "src/main.ts:10",
          body: "Suggestion",
          resolved: false,
          outdated: false,
          replies: [],
        },
      ],
    };

    const deps = makeDeps({
      ipcCall: (() => Promise.resolve(copilotSnapshot)) as PrDeps["ipcCall"],
    });

    await prWaitForCopilot(["42"], deps);
  });

  test("exits 1 on parse error", async () => {
    const errors: string[] = [];
    const deps = makeDeps({ printError: (m: string) => errors.push(m) });
    await expect(prWaitForCopilot([], deps)).rejects.toBeInstanceOf(ExitError);
    expect(errors[0]).toMatch(/Usage/);
  });

  test("exits 1 when event stream dies and Copilot not ready", async () => {
    const errors: string[] = [];
    const deps = makeDeps({
      ipcCall: (() => Promise.resolve(emptySnapshot)) as PrDeps["ipcCall"],
      printError: (m: string) => errors.push(m),
      openStream: () => ({
        events: (async function* () {
          // Stream ends immediately (simulates daemon restart)
        })(),
        abort: () => {},
      }),
    });

    const err = await prWaitForCopilot(["42", "--max-wait", "60"], deps).catch((e) => e);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).code).toBe(1);
    expect(errors.some((e: string) => e.includes("Timed out"))).toBe(true);
  });

  test("exits 0 when event stream dies but final check finds Copilot ready", async () => {
    const copilotSnapshot: PrThreadSnapshot = {
      ...emptySnapshot,
      pushedAt: new Date(Date.now() - 120_000).toISOString(),
      reviews: [{ id: 1, user: "Copilot", state: "COMMENTED", body: "LGTM" }],
    };

    let callCount = 0;
    const deps = makeDeps({
      ipcCall: (() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(emptySnapshot);
        return Promise.resolve(copilotSnapshot);
      }) as PrDeps["ipcCall"],
      openStream: () => ({
        events: (async function* () {
          // Stream dies immediately
        })(),
        abort: () => {},
      }),
    });

    await prWaitForCopilot(["42"], deps);
    expect(callCount).toBe(2);
  });

  test("exits 1 on timeout when Copilot never posts", async () => {
    const errors: string[] = [];
    const deps = makeDeps({
      ipcCall: (() => Promise.resolve(emptySnapshot)) as PrDeps["ipcCall"],
      printError: (m: string) => errors.push(m),
      openStream: () => ({
        events: (async function* () {
          // Yield one event to exercise the loop
          yield { type: "pr.review_comment_posted", ts: Date.now() } as never;
        })(),
        abort: () => {},
      }),
    });

    const err = await prWaitForCopilot(["42", "--max-wait", "0"], deps).catch((e) => e);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).code).toBe(1);
    expect(errors.some((e: string) => e.includes("Timed out"))).toBe(true);
  });

  test("returns false when Copilot posted but pushedAt is null", async () => {
    const snapshot: PrThreadSnapshot = {
      ...emptySnapshot,
      pushedAt: null,
      threads: [
        {
          threadId: "T1",
          rootCommentId: 100,
          user: "Copilot",
          location: "src/main.ts:10",
          body: "Suggestion",
          resolved: false,
          outdated: false,
          replies: [],
        },
      ],
    };

    const errors: string[] = [];
    const deps = makeDeps({
      ipcCall: (() => Promise.resolve(snapshot)) as PrDeps["ipcCall"],
      printError: (m: string) => errors.push(m),
      openStream: () => ({
        events: (async function* () {})(),
        abort: () => {},
      }),
    });

    const err = await prWaitForCopilot(["42", "--max-wait", "0"], deps).catch((e) => e);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).code).toBe(1);
  });

  test("returns false when Copilot posted but push is too recent", async () => {
    const snapshot: PrThreadSnapshot = {
      ...emptySnapshot,
      pushedAt: new Date(Date.now() - 10_000).toISOString(),
      threads: [
        {
          threadId: "T1",
          rootCommentId: 100,
          user: "Copilot",
          location: "src/main.ts:10",
          body: "Suggestion",
          resolved: false,
          outdated: false,
          replies: [],
        },
      ],
    };

    const errors: string[] = [];
    const deps = makeDeps({
      ipcCall: (() => Promise.resolve(snapshot)) as PrDeps["ipcCall"],
      printError: (m: string) => errors.push(m),
      openStream: () => ({
        events: (async function* () {})(),
        abort: () => {},
      }),
    });

    const err = await prWaitForCopilot(["42", "--max-wait", "0"], deps).catch((e) => e);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).code).toBe(1);
  });
});

// ── formatSnapshotXml ──

describe("formatSnapshotXml", () => {
  test("renders empty snapshot", () => {
    const xml = formatSnapshotXml(emptySnapshot);
    expect(xml).toContain("<pr-threads");
    expect(xml).toContain("</pr-threads>");
    expect(xml).not.toContain("<thread");
  });

  test("renders threads with replies", () => {
    const snapshot: PrThreadSnapshot = {
      ...emptySnapshot,
      threads: [
        {
          threadId: "T_abc",
          rootCommentId: 1,
          user: "Copilot",
          location: "src/index.ts:42",
          body: "Consider using const",
          resolved: false,
          outdated: false,
          replies: [{ user: "dev", body: "Fixed", commentId: 2 }],
        },
      ],
    };

    const xml = formatSnapshotXml(snapshot);
    expect(xml).toContain('id="T_abc"');
    expect(xml).toContain('location="src/index.ts:42"');
    expect(xml).toContain('user="Copilot"');
    expect(xml).toContain("Consider using const");
    expect(xml).toContain('user="dev"');
    expect(xml).toContain("Fixed");
  });

  test("renders reviews section", () => {
    const snapshot: PrThreadSnapshot = {
      ...emptySnapshot,
      reviews: [{ id: 10, user: "reviewer", state: "CHANGES_REQUESTED", body: "Please fix" }],
    };

    const xml = formatSnapshotXml(snapshot);
    expect(xml).toContain("<reviews>");
    expect(xml).toContain('state="CHANGES_REQUESTED"');
    expect(xml).toContain("Please fix");
  });

  test("renders top-level comments section", () => {
    const snapshot: PrThreadSnapshot = {
      ...emptySnapshot,
      topLevelComments: [{ id: 20, user: "commenter", body: "Nice work" }],
    };

    const xml = formatSnapshotXml(snapshot);
    expect(xml).toContain("<comments>");
    expect(xml).toContain('user="commenter"');
    expect(xml).toContain("Nice work");
  });

  test("escapes XML entities", () => {
    const snapshot: PrThreadSnapshot = {
      ...emptySnapshot,
      threads: [
        {
          threadId: "T1",
          rootCommentId: 1,
          user: "bot",
          location: "a.ts:1",
          body: 'x < 5 && y > 3 & "z"',
          resolved: false,
          outdated: false,
          replies: [],
        },
      ],
    };

    const xml = formatSnapshotXml(snapshot);
    expect(xml).toContain("&lt;");
    expect(xml).toContain("&gt;");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&quot;");
    expect(xml).not.toContain("< 5");
  });
});

// ── parsePrResolveArgs ──

describe("parsePrResolveArgs", () => {
  test("parses single-thread resolve", () => {
    const r = parsePrResolveArgs(["42", "resolve", "PRRT_abc"]);
    expect(r.prNumber).toBe(42);
    expect(r.threadId).toBe("PRRT_abc");
    expect(r.allAddressed).toBe(false);
    expect(r.replyText).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  test("parses single-thread resolve with reply text", () => {
    const r = parsePrResolveArgs(["42", "resolve", "PRRT_abc", "Done, fixed now"]);
    expect(r.threadId).toBe("PRRT_abc");
    expect(r.replyText).toBe("Done, fixed now");
    expect(r.error).toBeUndefined();
  });

  test("joins multi-word reply text", () => {
    const r = parsePrResolveArgs(["1", "resolve", "T1", "Fixed", "in", "latest", "commit"]);
    expect(r.replyText).toBe("Fixed in latest commit");
  });

  test("parses --all-addressed", () => {
    const r = parsePrResolveArgs(["42", "resolve", "--all-addressed"]);
    expect(r.prNumber).toBe(42);
    expect(r.allAddressed).toBe(true);
    expect(r.threadId).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  test("errors when no PR number", () => {
    const r = parsePrResolveArgs([]);
    expect(r.error).toMatch(/Usage/);
  });

  test("errors on invalid PR number", () => {
    const r = parsePrResolveArgs(["abc", "resolve", "T1"]);
    expect(r.error).toMatch(/Invalid PR number/);
  });

  test("errors when target missing after resolve", () => {
    const r = parsePrResolveArgs(["42", "resolve"]);
    expect(r.error).toMatch(/Usage/);
  });

  test("errors on unknown flag as target", () => {
    const r = parsePrResolveArgs(["42", "resolve", "--bogus"]);
    expect(r.error).toMatch(/Unknown flag/);
  });
});

// ── prCommentsResolve ──

const threadWithReply = {
  threadId: "PRRT_abc",
  rootCommentId: 100,
  user: "reviewer",
  location: "src/index.ts:10",
  body: "Please fix this",
  resolved: false,
  outdated: false,
  replies: [{ user: "dev", body: "Fixed", commentId: 101 }],
};

const threadWithoutReply = {
  threadId: "PRRT_xyz",
  rootCommentId: 200,
  user: "reviewer",
  location: "src/other.ts:5",
  body: "Another comment",
  resolved: false,
  outdated: false,
  replies: [],
};

const resolvedThread = {
  ...threadWithReply,
  threadId: "PRRT_done",
  rootCommentId: 300,
  resolved: true,
};

function makeResolveSnapshot(threads = [threadWithReply, threadWithoutReply]): PrThreadSnapshot {
  return { ...emptySnapshot, threads };
}

describe("prCommentsResolve", () => {
  test("resolves a single thread via gh api graphql", async () => {
    const execCalls: string[][] = [];
    const deps = makeDeps({
      exec: (cmd: string[]) => {
        execCalls.push(cmd);
        return { stdout: '{"data":{}}', stderr: "", exitCode: 0 };
      },
      ipcCall: (() => Promise.resolve(makeResolveSnapshot())) as PrDeps["ipcCall"],
    });
    await prCommentsResolve(["42", "resolve", "PRRT_abc"], deps);
    expect(execCalls).toHaveLength(1);
    const [cmd] = execCalls;
    expect(cmd[0]).toBe("gh");
    expect(cmd[1]).toBe("api");
    expect(cmd[2]).toBe("graphql");
    expect(cmd.join(" ")).toContain("resolveReviewThread");
    expect(cmd.join(" ")).toContain("PRRT_abc");
  });

  test("posts reply then resolves when reply text given", async () => {
    const execCalls: string[][] = [];
    const snapshot = makeResolveSnapshot([threadWithReply]);
    const deps = makeDeps({
      exec: (cmd: string[]) => {
        execCalls.push(cmd);
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
      ipcCall: (() => Promise.resolve(snapshot)) as PrDeps["ipcCall"],
    });
    await prCommentsResolve(["42", "resolve", "PRRT_abc", "Done, see latest commit"], deps);
    expect(execCalls).toHaveLength(2);
    // First call: reply
    expect(execCalls[0].join(" ")).toContain("/pulls/42/comments");
    expect(execCalls[0].join(" ")).toContain("Done, see latest commit");
    expect(execCalls[0].join(" ")).toContain("in_reply_to=100");
    // Second call: resolve
    expect(execCalls[1].join(" ")).toContain("resolveReviewThread");
  });

  test("exits with error when thread not found for reply", async () => {
    const errors: string[] = [];
    const deps = makeDeps({
      ipcCall: (() => Promise.resolve(makeResolveSnapshot())) as PrDeps["ipcCall"],
      printError: (m: string) => errors.push(m),
    });
    await expect(prCommentsResolve(["42", "resolve", "PRRT_nonexistent", "reply text"], deps)).rejects.toBeInstanceOf(
      ExitError,
    );
    expect(errors[0]).toContain("PRRT_nonexistent");
  });

  test("exits when gh api graphql fails", async () => {
    const errors: string[] = [];
    const deps = makeDeps({
      exec: () => ({ stdout: "", stderr: "auth error", exitCode: 1 }),
      ipcCall: (() => Promise.resolve(makeResolveSnapshot())) as PrDeps["ipcCall"],
      printError: (m: string) => errors.push(m),
    });
    await expect(prCommentsResolve(["42", "resolve", "PRRT_abc"], deps)).rejects.toBeInstanceOf(ExitError);
    expect(errors[0]).toContain("auth error");
  });

  test("--all-addressed resolves threads with replies", async () => {
    const execCalls: string[][] = [];
    const snapshot = makeResolveSnapshot([threadWithReply, threadWithoutReply, resolvedThread]);
    const deps = makeDeps({
      exec: (cmd: string[]) => {
        execCalls.push(cmd);
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
      ipcCall: (() => Promise.resolve(snapshot)) as PrDeps["ipcCall"],
    });
    await prCommentsResolve(["42", "resolve", "--all-addressed"], deps);
    // Only threadWithReply is unresolved with a reply
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].join(" ")).toContain("PRRT_abc");
  });

  test("--all-addressed skips threads without replies", async () => {
    const execCalls: string[][] = [];
    const snapshot = makeResolveSnapshot([threadWithoutReply]);
    const deps = makeDeps({
      exec: (cmd: string[]) => {
        execCalls.push(cmd);
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
      ipcCall: (() => Promise.resolve(snapshot)) as PrDeps["ipcCall"],
    });
    await prCommentsResolve(["42", "resolve", "--all-addressed"], deps);
    expect(execCalls).toHaveLength(0);
  });

  test("--all-addressed skips already-resolved threads", async () => {
    const execCalls: string[][] = [];
    const snapshot = makeResolveSnapshot([resolvedThread]);
    const deps = makeDeps({
      exec: (cmd: string[]) => {
        execCalls.push(cmd);
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
      ipcCall: (() => Promise.resolve(snapshot)) as PrDeps["ipcCall"],
    });
    await prCommentsResolve(["42", "resolve", "--all-addressed"], deps);
    expect(execCalls).toHaveLength(0);
  });

  test("--all-addressed continues resolving after a failure", async () => {
    const errors: string[] = [];
    const failThread = { ...threadWithReply, threadId: "PRRT_fail", rootCommentId: 999 };
    const snapshot = makeResolveSnapshot([failThread, threadWithReply]);
    let call = 0;
    const deps = makeDeps({
      exec: () => {
        call++;
        if (call === 1) return { stdout: "", stderr: "fail", exitCode: 1 };
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
      ipcCall: (() => Promise.resolve(snapshot)) as PrDeps["ipcCall"],
      printError: (m: string) => errors.push(m),
    });
    await prCommentsResolve(["42", "resolve", "--all-addressed"], deps);
    expect(errors.some((e) => e.includes("PRRT_fail"))).toBe(true);
    expect(call).toBe(2);
  });

  test("exits with usage error when args missing", async () => {
    const errors: string[] = [];
    const deps = makeDeps({ printError: (m: string) => errors.push(m) });
    await expect(prCommentsResolve([], deps)).rejects.toBeInstanceOf(ExitError);
    expect(errors[0]).toMatch(/Usage/);
  });

  test("prComments routes to resolve when second arg is 'resolve'", async () => {
    const execCalls: string[][] = [];
    const snapshot = makeResolveSnapshot([threadWithReply]);
    const deps = makeDeps({
      exec: (cmd: string[]) => {
        execCalls.push(cmd);
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
      ipcCall: (() => Promise.resolve(snapshot)) as PrDeps["ipcCall"],
    });
    await prComments(["42", "resolve", "PRRT_abc"], deps);
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].join(" ")).toContain("resolveReviewThread");
  });
});

// ── cmdPr ──

describe("cmdPr", () => {
  test("prints usage with no args", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = ((m: string) => logs.push(m)) as typeof console.log;
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
      exec: (cmd: string[]) => {
        calls.push(cmd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    await cmdPr(["merge", "42"], deps);
    expect(calls[0]).toContain("42");
  });

  test("routes to prComments on 'comments' subcommand", async () => {
    const ipcCalls: Array<{ method: string }> = [];
    const deps = makeDeps({
      ipcCall: ((method: string, params: unknown) => {
        ipcCalls.push({ method });
        return Promise.resolve(emptySnapshot);
      }) as PrDeps["ipcCall"],
    });

    const origLog = console.log;
    console.log = (() => {}) as typeof console.log;
    try {
      await cmdPr(["comments", "10"], deps);
    } finally {
      console.log = origLog;
    }

    expect(ipcCalls[0].method).toBe("getPrThreadSnapshot");
  });

  test("exits on unknown subcommand", async () => {
    const errors: string[] = [];
    const deps = makeDeps({ printError: (m: string) => errors.push(m) });
    await expect(cmdPr(["frobnicate"], deps)).rejects.toBeInstanceOf(ExitError);
    expect(errors[0]).toContain("Unknown pr subcommand");
  });

  test("usage includes new subcommands", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = ((m: string) => logs.push(m)) as typeof console.log;
    try {
      await cmdPr(["--help"]);
      const output = logs.join("");
      expect(output).toContain("comments");
      expect(output).toContain("wait-for-copilot");
      expect(output).toContain("resolve");
      expect(output).toContain("--all-addressed");
    } finally {
      console.log = origLog;
    }
  });
});
