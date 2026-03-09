import { afterEach, describe, expect, mock, test } from "bun:test";
import { _resetJqStateForTesting } from "../jq/index";
import { ExitError } from "../test-helpers";
import type { ClaudeDeps } from "./claude";
import {
  MODEL_SHORTNAMES,
  cmdClaude,
  defaultGetPrStatus,
  extractContentSummary,
  parseDiffShortstat,
  parseLogArgs,
  parseSpawnArgs,
  parseWaitArgs,
  parseWorktreeList,
  resolveModelName,
  resolveSessionId,
} from "./claude";

// ── Helpers ──

function makeDeps(overrides?: Partial<ClaudeDeps>): ClaudeDeps {
  return {
    callTool: mock(async () => ({ content: [{ type: "text", text: "[]" }] })),
    printError: mock(() => {}),
    exit: mock((code: number) => {
      throw new ExitError(code);
    }) as ClaudeDeps["exit"],
    getDiffStats: mock(async () => null),
    getPrStatus: mock(async () => null),
    exec: mock(() => ({ stdout: "", exitCode: 0 })),
    ...overrides,
  };
}

function toolResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

const SESSION_LIST = [
  {
    sessionId: "abc12345-1111-2222-3333-444444444444",
    state: "active",
    model: "opus-4",
    cwd: "/tmp",
    cost: 0.05,
    tokens: 1000,
    numTurns: 3,
    pendingPermissions: 0,
    worktree: null,
  },
  {
    sessionId: "def67890-aaaa-bbbb-cccc-dddddddddddd",
    state: "idle",
    model: "sonnet-4",
    cwd: "/home",
    cost: 0.02,
    tokens: 500,
    numTurns: 1,
    pendingPermissions: 0,
    worktree: null,
  },
];

// ── parseDiffShortstat ──

describe("parseDiffShortstat", () => {
  test("parses full shortstat output", () => {
    expect(parseDiffShortstat(" 4 files changed, 142 insertions(+), 38 deletions(-)\n")).toBe("+142/-38 (4f)");
  });

  test("parses insertions only", () => {
    expect(parseDiffShortstat(" 2 files changed, 50 insertions(+)\n")).toBe("+50/-0 (2f)");
  });

  test("parses deletions only", () => {
    expect(parseDiffShortstat(" 1 file changed, 10 deletions(-)\n")).toBe("+0/-10 (1f)");
  });

  test("returns null for empty output", () => {
    expect(parseDiffShortstat("")).toBeNull();
    expect(parseDiffShortstat("  \n")).toBeNull();
  });
});

// ── parseSpawnArgs ──

describe("parseSpawnArgs", () => {
  test("parses --task flag", () => {
    const result = parseSpawnArgs(["--task", "fix bug"]);
    expect(result.task).toBe("fix bug");
    expect(result.error).toBeUndefined();
  });

  test("parses -t shorthand", () => {
    const result = parseSpawnArgs(["-t", "fix bug"]);
    expect(result.task).toBe("fix bug");
  });

  test("parses positional task", () => {
    const result = parseSpawnArgs(["fix the tests"]);
    expect(result.task).toBe("fix the tests");
  });

  test("--task takes precedence over positional", () => {
    const result = parseSpawnArgs(["--task", "from flag", "positional"]);
    expect(result.task).toBe("from flag");
  });

  test("parses --worktree with name", () => {
    const result = parseSpawnArgs(["--worktree", "my-feature", "--task", "x"]);
    expect(result.worktree).toBe("my-feature");
  });

  test("parses --worktree without name (auto-generates)", () => {
    const result = parseSpawnArgs(["--worktree", "--task", "x"]);
    expect(result.worktree).toBeDefined();
    expect(result.worktree).toStartWith("claude-");
  });

  test("parses -w shorthand", () => {
    const result = parseSpawnArgs(["-w", "feat", "-t", "x"]);
    expect(result.worktree).toBe("feat");
  });

  test("parses --resume", () => {
    const result = parseSpawnArgs(["--resume", "abc123", "--task", "continue"]);
    expect(result.resume).toBe("abc123");
  });

  test("parses --allow with multiple tools", () => {
    const result = parseSpawnArgs(["--allow", "Read", "Glob", "Grep", "--task", "x"]);
    expect(result.allow).toEqual(["Read", "Glob", "Grep"]);
  });

  test("parses --cwd", () => {
    const result = parseSpawnArgs(["--cwd", "/tmp/work", "--task", "x"]);
    expect(result.cwd).toBe("/tmp/work");
  });

  test("parses --timeout", () => {
    const result = parseSpawnArgs(["--timeout", "60000", "--task", "x"]);
    expect(result.timeout).toBe(60000);
  });

  test("errors on missing --task value", () => {
    const result = parseSpawnArgs(["--task"]);
    expect(result.error).toBe("--task requires a value");
  });

  test("errors on missing --resume value", () => {
    const result = parseSpawnArgs(["--resume"]);
    expect(result.error).toBe("--resume requires a session ID");
  });

  test("errors on non-numeric --timeout", () => {
    const result = parseSpawnArgs(["--timeout", "abc"]);
    expect(result.error).toBe("--timeout must be a number");
  });

  test("errors on empty --allow", () => {
    const result = parseSpawnArgs(["--allow", "--task", "x"]);
    expect(result.allow).toEqual([]);
    // --allow stops collecting when it hits --task (a flag), so allow is empty
    expect(result.error).toBe("--allow requires at least one tool pattern");
  });

  test("parses --wait flag", () => {
    const result = parseSpawnArgs(["--task", "fix bug", "--wait"]);
    expect(result.wait).toBe(true);
    expect(result.task).toBe("fix bug");
  });

  test("wait defaults to false", () => {
    const result = parseSpawnArgs(["--task", "fix bug"]);
    expect(result.wait).toBe(false);
  });

  test("parses --model with shortname", () => {
    const result = parseSpawnArgs(["--model", "sonnet", "--task", "x"]);
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  test("parses -m shorthand", () => {
    const result = parseSpawnArgs(["-m", "haiku", "-t", "x"]);
    expect(result.model).toBe("claude-haiku-4-5-20251001");
  });

  test("passes through full model ID", () => {
    const result = parseSpawnArgs(["--model", "claude-opus-4-6", "--task", "x"]);
    expect(result.model).toBe("claude-opus-4-6");
  });

  test("model defaults to undefined", () => {
    const result = parseSpawnArgs(["--task", "x"]);
    expect(result.model).toBeUndefined();
  });

  test("errors on missing --model value", () => {
    const result = parseSpawnArgs(["--model"]);
    expect(result.error).toBe("--model requires a value");
  });
});

// ── resolveModelName ──

describe("resolveModelName", () => {
  test("resolves opus shortname", () => {
    expect(resolveModelName("opus")).toBe("claude-opus-4-6");
  });

  test("resolves sonnet shortname", () => {
    expect(resolveModelName("sonnet")).toBe("claude-sonnet-4-6");
  });

  test("resolves haiku shortname", () => {
    expect(resolveModelName("haiku")).toBe("claude-haiku-4-5-20251001");
  });

  test("is case-insensitive", () => {
    expect(resolveModelName("Opus")).toBe("claude-opus-4-6");
    expect(resolveModelName("SONNET")).toBe("claude-sonnet-4-6");
  });

  test("passes through unknown model IDs", () => {
    expect(resolveModelName("claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(resolveModelName("some-custom-model")).toBe("some-custom-model");
  });
});

// ── parseLogArgs ──

describe("parseLogArgs", () => {
  test("parses session prefix and default last", () => {
    const result = parseLogArgs(["abc123"]);
    expect(result.sessionPrefix).toBe("abc123");
    expect(result.last).toBe(20);
  });

  test("parses --last flag", () => {
    const result = parseLogArgs(["abc123", "--last", "50"]);
    expect(result.last).toBe(50);
  });

  test("parses -n shorthand", () => {
    const result = parseLogArgs(["abc123", "-n", "10"]);
    expect(result.last).toBe(10);
  });

  test("parses --json flag", () => {
    const result = parseLogArgs(["abc123", "--json"]);
    expect(result.json).toBe(true);
    expect(result.sessionPrefix).toBe("abc123");
  });

  test("parses -j shorthand", () => {
    const result = parseLogArgs(["abc123", "-j"]);
    expect(result.json).toBe(true);
  });

  test("parses --full flag", () => {
    const result = parseLogArgs(["abc123", "--full"]);
    expect(result.full).toBe(true);
    expect(result.sessionPrefix).toBe("abc123");
  });

  test("parses -f shorthand for --full", () => {
    const result = parseLogArgs(["abc123", "-f"]);
    expect(result.full).toBe(true);
  });

  test("parses --format json (delegated to extractJsonFlag)", () => {
    const result = parseLogArgs(["abc123", "--format", "json"]);
    expect(result.json).toBe(true);
    expect(result.sessionPrefix).toBe("abc123");
  });

  test("defaults json and full to false", () => {
    const result = parseLogArgs(["abc123"]);
    expect(result.json).toBe(false);
    expect(result.full).toBe(false);
  });

  test("errors on non-numeric --last", () => {
    const result = parseLogArgs(["abc123", "--last", "abc"]);
    expect(result.error).toBe("--last must be a number");
  });

  test("parses --jq flag", () => {
    const result = parseLogArgs(["abc123", "--json", "--jq", ".[-1].message.type"]);
    expect(result.jq).toBe(".[-1].message.type");
    expect(result.json).toBe(true);
    expect(result.sessionPrefix).toBe("abc123");
  });

  test("defaults jq to undefined", () => {
    const result = parseLogArgs(["abc123"]);
    expect(result.jq).toBeUndefined();
  });

  test("parses --jq with complex filter", () => {
    const result = parseLogArgs(["abc123", "--json", "--jq", '[.[] | select(.direction=="inbound")]']);
    expect(result.jq).toBe('[.[] | select(.direction=="inbound")]');
  });
});

// ── claudeLog --jq runtime ──

describe("cmdClaude log --json --jq", () => {
  afterEach(() => {
    _resetJqStateForTesting();
  });

  test("prints error and exits when jq is unavailable", async () => {
    _resetJqStateForTesting("test: WASM not loaded");
    const transcript = [{ timestamp: 1000, direction: "inbound", message: { type: "user" } }];
    const deps = makeDeps({
      callTool: mock(async (tool) => {
        if (tool === "claude_session_list") return toolResult(SESSION_LIST);
        return toolResult(transcript);
      }),
    });
    await expect(cmdClaude(["log", "--json", "--jq", ".[-1]", "abc"], deps)).rejects.toBeInstanceOf(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("jq-web unavailable"));
  });

  test("prints error and exits when transcript is not valid JSON", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool) => {
        if (tool === "claude_session_list") return toolResult(SESSION_LIST);
        // Return non-JSON text
        return { content: [{ type: "text", text: "not json" }] };
      }),
    });
    await expect(cmdClaude(["log", "--json", "--jq", ".", "abc"], deps)).rejects.toBeInstanceOf(ExitError);
    expect(deps.printError).toHaveBeenCalled();
  });
});

// ── resolveSessionId ──

describe("resolveSessionId", () => {
  test("resolves exact match", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    const id = await resolveSessionId("abc12345-1111-2222-3333-444444444444", deps);
    expect(id).toBe("abc12345-1111-2222-3333-444444444444");
  });

  test("resolves prefix match", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    const id = await resolveSessionId("abc", deps);
    expect(id).toBe("abc12345-1111-2222-3333-444444444444");
  });

  test("resolves short prefix", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    const id = await resolveSessionId("def", deps);
    expect(id).toBe("def67890-aaaa-bbbb-cccc-dddddddddddd");
  });

  test("errors on no match", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    await expect(resolveSessionId("zzz", deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining('No session matching "zzz"'));
  });

  test("errors on ambiguous match", async () => {
    const sessions = [
      {
        sessionId: "abc11111",
        state: "active",
        model: null,
        cwd: null,
        cost: 0,
        tokens: 0,
        numTurns: 0,
        pendingPermissions: 0,
        worktree: null,
      },
      {
        sessionId: "abc22222",
        state: "active",
        model: null,
        cwd: null,
        cost: 0,
        tokens: 0,
        numTurns: 0,
        pendingPermissions: 0,
        worktree: null,
      },
    ];
    const deps = makeDeps({
      callTool: mock(async () => toolResult(sessions)),
    });
    await expect(resolveSessionId("abc", deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Ambiguous"));
  });
});

// ── cmdClaude dispatch ──

describe("cmdClaude", () => {
  test("shows usage with no args", async () => {
    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude([]);
      expect(logSpy).toHaveBeenCalled();
      const output = (logSpy.mock.calls[0] as string[])[0];
      expect(output).toContain("mcx claude");
    } finally {
      console.log = origLog;
    }
  });

  test("shows usage with --help", async () => {
    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["--help"]);
      expect(logSpy).toHaveBeenCalled();
    } finally {
      console.log = origLog;
    }
  });

  test("errors on unknown subcommand", async () => {
    const deps = makeDeps();
    await expect(cmdClaude(["unknown"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Unknown claude subcommand"));
  });
});

// ── spawn ──

describe("mcx claude spawn", () => {
  test("calls claude_prompt with task", async () => {
    const callTool = mock(async () => toolResult({ sessionId: "abc", success: true, cost: 0.01 }));
    const deps = makeDeps({ callTool });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["spawn", "--task", "fix the bug"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_prompt", { prompt: "fix the bug" });
    } finally {
      console.log = origLog;
    }
  });

  test("passes worktree and allowedTools", async () => {
    const callTool = mock(async () => toolResult({ success: true }));
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["spawn", "--task", "x", "--worktree", "feat", "--allow", "Read", "Glob"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_prompt", {
        prompt: "x",
        worktree: "feat",
        allowedTools: ["Read", "Glob"],
      });
    } finally {
      console.log = origLog;
    }
  });

  test("passes resume as sessionId", async () => {
    const callTool = mock(async () => toolResult({ success: true }));
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["spawn", "--resume", "abc123", "--task", "continue"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_prompt", {
        prompt: "continue",
        sessionId: "abc123",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("uses default prompt when --resume without --task", async () => {
    const callTool = mock(async () => toolResult({ success: true }));
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["spawn", "--resume", "abc123"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_prompt", {
        prompt: "Continue from where you left off.",
        sessionId: "abc123",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("passes wait flag when --wait is set", async () => {
    const callTool = mock(async () => toolResult({ sessionId: "abc", success: true }));
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["spawn", "--task", "fix", "--wait"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_prompt", { prompt: "fix", wait: true });
    } finally {
      console.log = origLog;
    }
  });

  test("does not pass wait flag by default", async () => {
    const callTool = mock(async () => toolResult({ sessionId: "abc" }));
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["spawn", "--task", "fix"], deps);
      const callArgs = (callTool.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
      expect(callArgs.wait).toBeUndefined();
    } finally {
      console.log = origLog;
    }
  });

  test("passes model to callTool when --model is specified", async () => {
    const callTool = mock(async () => toolResult({ sessionId: "abc" }));
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["spawn", "--task", "fix", "--model", "sonnet"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_prompt", {
        prompt: "fix",
        model: "claude-sonnet-4-6",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("errors when no task and no resume", async () => {
    const deps = makeDeps();
    await expect(cmdClaude(["spawn"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });
});

// ── ls ──

describe("mcx claude ls", () => {
  test("outputs table for sessions", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["ls"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("claude_session_list", {});
      // Should have header + 2 session rows
      expect(logSpy.mock.calls.length).toBe(3);
      const header = (logSpy.mock.calls[0] as string[])[0];
      expect(header).toContain("SESSION");
    } finally {
      console.log = origLog;
    }
  });

  test("outputs JSON with -j flag", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["ls", "-j"], deps);
      const output = (logSpy.mock.calls[0] as string[])[0];
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(2);
    } finally {
      console.log = origLog;
    }
  });

  test("shows message when no sessions", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult([])),
    });

    const errSpy = mock(() => {});
    const origErr = console.error;
    console.error = errSpy;
    try {
      await cmdClaude(["ls"], deps);
      expect(errSpy).toHaveBeenCalledWith("No active sessions.");
    } finally {
      console.error = origErr;
    }
  });

  test("accepts 'list' alias", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult([])),
    });
    const origErr = console.error;
    console.error = mock(() => {});
    try {
      await cmdClaude(["list"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("claude_session_list", {});
    } finally {
      console.error = origErr;
    }
  });

  test("shows DIFF column when sessions have worktrees", async () => {
    const sessionsWithWorktree = [
      { ...SESSION_LIST[0], worktree: "/tmp/wt1" },
      { ...SESSION_LIST[1], worktree: "/tmp/wt2" },
    ];
    const getDiffStats = mock(async (path: string) => {
      if (path === "/tmp/wt1") return "+142/-38 (4f)";
      if (path === "/tmp/wt2") return "+89/-12 (3f)";
      return null;
    });
    const deps = makeDeps({
      callTool: mock(async () => toolResult(sessionsWithWorktree)),
      getDiffStats,
    });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["ls"], deps);
      const header = (logSpy.mock.calls[0] as string[])[0];
      expect(header).toContain("DIFF");
      const row1 = (logSpy.mock.calls[1] as string[])[0];
      expect(row1).toContain("+142/-38 (4f)");
      const row2 = (logSpy.mock.calls[2] as string[])[0];
      expect(row2).toContain("+89/-12 (3f)");
      expect(getDiffStats).toHaveBeenCalledTimes(2);
    } finally {
      console.log = origLog;
    }
  });

  test("hides DIFF column when no sessions have worktrees", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["ls"], deps);
      const header = (logSpy.mock.calls[0] as string[])[0];
      expect(header).not.toContain("DIFF");
    } finally {
      console.log = origLog;
    }
  });

  test("shows dash for worktree sessions with no changes", async () => {
    const sessionsWithWorktree = [{ ...SESSION_LIST[0], worktree: "/tmp/wt1" }, { ...SESSION_LIST[1] }];
    const getDiffStats = mock(async (path: string) => {
      if (path === "/tmp/wt1") return "+10/-5 (2f)";
      return null;
    });
    const deps = makeDeps({
      callTool: mock(async () => toolResult(sessionsWithWorktree)),
      getDiffStats,
    });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["ls"], deps);
      const header = (logSpy.mock.calls[0] as string[])[0];
      expect(header).toContain("DIFF");
      const row1 = (logSpy.mock.calls[1] as string[])[0];
      expect(row1).toContain("+10/-5 (2f)");
    } finally {
      console.log = origLog;
    }
  });

  test("shows PR column with --pr flag", async () => {
    const sessionsWithWorktree = [
      { ...SESSION_LIST[0], worktree: "/tmp/wt1" },
      { ...SESSION_LIST[1], worktree: "/tmp/wt2" },
    ];
    const getPrStatus = mock(async (path: string) => {
      if (path === "/tmp/wt1") return { number: 263, state: "open" };
      return null;
    });
    const deps = makeDeps({
      callTool: mock(async () => toolResult(sessionsWithWorktree)),
      getPrStatus,
    });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["ls", "--pr"], deps);
      const header = (logSpy.mock.calls[0] as string[])[0];
      expect(header).toContain("PR");
      const row1 = (logSpy.mock.calls[1] as string[])[0];
      expect(row1).toContain("#263 open");
      const row2 = (logSpy.mock.calls[2] as string[])[0];
      expect(row2).toContain("—");
      expect(getPrStatus).toHaveBeenCalledTimes(2);
    } finally {
      console.log = origLog;
    }
  });

  test("does not show PR column without --pr flag", async () => {
    const sessionsWithWorktree = [{ ...SESSION_LIST[0], worktree: "/tmp/wt1" }];
    const getPrStatus = mock(async () => ({ number: 263, state: "open" }));
    const deps = makeDeps({
      callTool: mock(async () => toolResult(sessionsWithWorktree)),
      getPrStatus,
    });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["ls"], deps);
      const header = (logSpy.mock.calls[0] as string[])[0];
      expect(header).not.toContain("PR");
      expect(getPrStatus).not.toHaveBeenCalled();
    } finally {
      console.log = origLog;
    }
  });

  test("hides PR column when all PRs are null", async () => {
    const sessionsWithWorktree = [{ ...SESSION_LIST[0], worktree: "/tmp/wt1" }];
    const getPrStatus = mock(async () => null);
    const deps = makeDeps({
      callTool: mock(async () => toolResult(sessionsWithWorktree)),
      getPrStatus,
    });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["ls", "--pr"], deps);
      const header = (logSpy.mock.calls[0] as string[])[0];
      expect(header).not.toContain("PR");
    } finally {
      console.log = origLog;
    }
  });
});

// ── defaultGetPrStatus ──

describe("defaultGetPrStatus", () => {
  test("is exported and is a function", () => {
    expect(typeof defaultGetPrStatus).toBe("function");
  });
});

// ── send ──

describe("mcx claude send", () => {
  test("sends prompt to resolved session", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ success: true });
    });
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["send", "abc", "fix the tests please"], deps);
      // First call: list sessions for resolution
      expect(callTool).toHaveBeenCalledWith("claude_session_list", {});
      // Second call: send prompt
      expect(callTool).toHaveBeenCalledWith("claude_prompt", {
        sessionId: "abc12345-1111-2222-3333-444444444444",
        prompt: "fix the tests please",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("errors when no session or message", async () => {
    const deps = makeDeps();
    await expect(cmdClaude(["send"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  test("errors when no message", async () => {
    const deps = makeDeps();
    await expect(cmdClaude(["send", "abc"], deps)).rejects.toThrow(ExitError);
  });

  test("passes wait flag when --wait is set", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ success: true });
    });
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["send", "--wait", "abc", "do something"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_prompt", {
        sessionId: "abc12345-1111-2222-3333-444444444444",
        prompt: "do something",
        wait: true,
      });
    } finally {
      console.log = origLog;
    }
  });

  test("does not pass wait flag by default", async () => {
    const callTool = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ sessionId: "abc12345-1111-2222-3333-444444444444" });
    });
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["send", "abc", "do something"], deps);
      const promptCall = (callTool.mock.calls as unknown as Array<[string, Record<string, unknown>]>).find(
        (c) => c[0] === "claude_prompt",
      );
      expect(promptCall).toBeDefined();
      expect(promptCall?.[1].wait).toBeUndefined();
    } finally {
      console.log = origLog;
    }
  });
});

// ── bye ──

describe("mcx claude bye", () => {
  test("ends resolved session", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ ended: true });
    });
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_bye", {
        sessionId: "def67890-aaaa-bbbb-cccc-dddddddddddd",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("accepts 'quit' alias", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ ended: true });
    });
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["quit", "abc"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_bye", {
        sessionId: "abc12345-1111-2222-3333-444444444444",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("errors when no session specified", async () => {
    const deps = makeDeps();
    await expect(cmdClaude(["bye"], deps)).rejects.toThrow(ExitError);
  });

  test("removes clean worktree after bye", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ ended: true, worktree: "claude-abc123", cwd: "/repo" });
    });
    const exec: ClaudeDeps["exec"] = mock((cmd: string[]) => {
      if (cmd.includes("status")) return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def"], deps);
      // Should call git worktree remove
      const removeCalls = (exec as ReturnType<typeof mock>).mock.calls.filter((c: unknown[]) =>
        (c[0] as string[]).includes("remove"),
      );
      expect(removeCalls.length).toBe(1);
      expect(removeCalls[0][0]).toContain("/repo/.claude/worktrees/claude-abc123");
      // Should print removal message via printError
      const errOutput = printError.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(errOutput).toContain("Removed worktree:");
    } finally {
      console.log = origLog;
    }
  });

  test("warns about dirty worktree after bye", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ ended: true, worktree: "claude-abc123", cwd: "/repo" });
    });
    const exec: ClaudeDeps["exec"] = mock((cmd: string[]) => {
      if (cmd.includes("status")) return { stdout: " M file.ts\n?? new.ts", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def"], deps);
      // Should NOT call git worktree remove
      const removeCalls = (exec as ReturnType<typeof mock>).mock.calls.filter((c: unknown[]) =>
        (c[0] as string[]).includes("remove"),
      );
      expect(removeCalls.length).toBe(0);
      // Should print warning via printError
      const errOutput = printError.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(errOutput).toContain("uncommitted changes");
      expect(errOutput).toContain("1 modified");
      expect(errOutput).toContain("1 untracked");
    } finally {
      console.log = origLog;
    }
  });

  test("skips cleanup when no worktree in bye response", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ ended: true, worktree: null, cwd: null });
    });
    const exec: ClaudeDeps["exec"] = mock(() => ({ stdout: "", exitCode: 0 }));
    const deps = makeDeps({ callTool, exec });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def"], deps);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      console.log = origLog;
    }
  });

  test("skips cleanup when worktree is already gone (git status fails)", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ ended: true, worktree: "claude-gone", cwd: "/repo" });
    });
    const exec: ClaudeDeps["exec"] = mock(() => ({ stdout: "", exitCode: 128 }));
    const printError = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def"], deps);
      // Should call git status but not git worktree remove
      expect(exec).toHaveBeenCalledTimes(1);
      expect((exec as ReturnType<typeof mock>).mock.calls[0][0]).toContain("status");
      // No removal messages
      expect(printError).not.toHaveBeenCalled();
    } finally {
      console.log = origLog;
    }
  });

  test("reports failure when git worktree remove fails", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ ended: true, worktree: "claude-locked", cwd: "/repo" });
    });
    const exec: ClaudeDeps["exec"] = mock((cmd: string[]) => {
      if (cmd.includes("status")) return { stdout: "", exitCode: 0 };
      if (cmd.includes("remove")) return { stdout: "", exitCode: 1 };
      return { stdout: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def"], deps);
      const errOutput = printError.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(errOutput).toContain("Failed to remove worktree:");
    } finally {
      console.log = origLog;
    }
  });

  test("skips cleanup for path traversal attempt", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ ended: true, worktree: "../../..", cwd: "/repo" });
    });
    const exec: ClaudeDeps["exec"] = mock(() => ({ stdout: "", exitCode: 0 }));
    const deps = makeDeps({ callTool, exec });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def"], deps);
      // exec should never be called — path traversal blocked
      expect(exec).not.toHaveBeenCalled();
    } finally {
      console.log = origLog;
    }
  });

  test("handles malformed bye response gracefully", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return { content: [{ type: "text", text: "not json" }] };
    });
    const exec: ClaudeDeps["exec"] = mock(() => ({ stdout: "", exitCode: 0 }));
    const deps = makeDeps({ callTool, exec });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def"], deps);
      // Should not attempt cleanup on malformed response
      expect(exec).not.toHaveBeenCalled();
    } finally {
      console.log = origLog;
    }
  });
});

// ── interrupt ──

describe("mcx claude interrupt", () => {
  test("interrupts resolved session", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ interrupted: true });
    });
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["interrupt", "def"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_interrupt", {
        sessionId: "def67890-aaaa-bbbb-cccc-dddddddddddd",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("errors when no session specified", async () => {
    const deps = makeDeps();
    await expect(cmdClaude(["interrupt"], deps)).rejects.toThrow(ExitError);
  });
});

// ── log ──

describe("mcx claude log", () => {
  test("fetches transcript with default limit", async () => {
    const transcript = [
      {
        timestamp: 1700000000000,
        direction: "outbound",
        message: { type: "user", message: { role: "user", content: "hello" } },
      },
      {
        timestamp: 1700000001000,
        direction: "inbound",
        message: { type: "assistant", message: { role: "assistant", content: "hi there" } },
      },
    ];
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult(transcript);
    });
    const deps = makeDeps({ callTool });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["log", "abc"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_transcript", {
        sessionId: "abc12345-1111-2222-3333-444444444444",
        limit: 20,
      });
      // Should output formatted entries
      expect(logSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      console.log = origLog;
    }
  });

  test("passes custom --last value", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult([]);
    });
    const deps = makeDeps({ callTool });

    await cmdClaude(["log", "abc", "--last", "5"], deps);
    expect(callTool).toHaveBeenCalledWith("claude_transcript", {
      sessionId: "abc12345-1111-2222-3333-444444444444",
      limit: 5,
    });
  });

  test("outputs raw JSON with --json flag", async () => {
    const transcript = [
      {
        timestamp: 1700000000000,
        direction: "outbound",
        message: { type: "user", message: { role: "user", content: "hello" } },
      },
    ];
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult(transcript);
    });
    const deps = makeDeps({ callTool });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["log", "abc", "--json"], deps);
      // Should output the raw JSON string, not formatted
      expect(logSpy.mock.calls.length).toBe(1);
      const output = (logSpy.mock.calls[0] as string[])[0];
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].message.type).toBe("user");
    } finally {
      console.log = origLog;
    }
  });

  test("outputs raw JSON with -j shorthand", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult([]);
    });
    const deps = makeDeps({ callTool });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["log", "abc", "-j"], deps);
      expect(logSpy.mock.calls.length).toBe(1);
      const parsed = JSON.parse((logSpy.mock.calls[0] as string[])[0]);
      expect(parsed).toEqual([]);
    } finally {
      console.log = origLog;
    }
  });

  test("shows full content with --full flag (no truncation)", async () => {
    const longContent = "x".repeat(500);
    const transcript = [
      {
        timestamp: 1700000000000,
        direction: "inbound",
        message: { type: "assistant", message: { role: "assistant", content: longContent } },
      },
    ];
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult(transcript);
    });
    const deps = makeDeps({ callTool });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["log", "abc", "--full"], deps);
      // Find the content line (second log call: first is header, second is content)
      const allOutput = (logSpy.mock.calls as string[][]).map((c) => c[0]).join("\n");
      expect(allOutput).toContain(longContent);
      expect(allOutput).not.toContain("…");
    } finally {
      console.log = origLog;
    }
  });

  test("shows full content for result-type messages with --full", async () => {
    const longResult = "r".repeat(500);
    const transcript = [
      {
        timestamp: 1700000000000,
        direction: "inbound",
        message: { type: "result", result: longResult },
      },
    ];
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult(transcript);
    });
    const deps = makeDeps({ callTool });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["log", "abc", "--full"], deps);
      const allOutput = (logSpy.mock.calls as string[][]).map((c) => c[0]).join("\n");
      expect(allOutput).toContain(longResult);
      expect(allOutput).not.toContain("…");
    } finally {
      console.log = origLog;
    }
  });

  test("truncates content without --full flag", async () => {
    const longContent = "x".repeat(500);
    const transcript = [
      {
        timestamp: 1700000000000,
        direction: "inbound",
        message: { type: "assistant", message: { role: "assistant", content: longContent } },
      },
    ];
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult(transcript);
    });
    const deps = makeDeps({ callTool });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["log", "abc"], deps);
      const allOutput = (logSpy.mock.calls as string[][]).map((c) => c[0]).join("\n");
      expect(allOutput).toContain("…");
      expect(allOutput).not.toContain(longContent);
    } finally {
      console.log = origLog;
    }
  });

  test("errors when no session specified", async () => {
    const deps = makeDeps();
    await expect(cmdClaude(["log"], deps)).rejects.toThrow(ExitError);
  });
});

// ── parseWaitArgs ──

describe("parseWaitArgs", () => {
  test("parses session prefix", () => {
    const result = parseWaitArgs(["abc123"]);
    expect(result.sessionPrefix).toBe("abc123");
    expect(result.timeout).toBeUndefined();
  });

  test("parses --timeout flag", () => {
    const result = parseWaitArgs(["abc123", "--timeout", "60000"]);
    expect(result.sessionPrefix).toBe("abc123");
    expect(result.timeout).toBe(60000);
  });

  test("parses -t shorthand", () => {
    const result = parseWaitArgs(["-t", "5000"]);
    expect(result.timeout).toBe(5000);
  });

  test("no args returns no session or timeout", () => {
    const result = parseWaitArgs([]);
    expect(result.sessionPrefix).toBeUndefined();
    expect(result.timeout).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  test("errors on non-numeric --timeout", () => {
    const result = parseWaitArgs(["--timeout", "abc"]);
    expect(result.error).toBe("--timeout must be a number");
  });

  test("errors on missing --timeout value", () => {
    const result = parseWaitArgs(["--timeout"]);
    expect(result.error).toBe("--timeout requires a value in ms");
  });
});

// ── wait ──

describe("mcx claude wait", () => {
  test("calls claude_wait with no args (any session)", async () => {
    const callTool = mock(async () => toolResult({ sessionId: "abc123", event: "session:result", cost: 0.05 }));
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["wait"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_wait", {});
    } finally {
      console.log = origLog;
    }
  });

  test("resolves session prefix and passes sessionId", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ sessionId: "abc12345-1111-2222-3333-444444444444", event: "session:result" });
    });
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["wait", "abc"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_wait", {
        sessionId: "abc12345-1111-2222-3333-444444444444",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("passes timeout when specified", async () => {
    const callTool = mock(async () => toolResult({ sessionId: "abc", event: "session:result" }));
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["wait", "--timeout", "60000"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_wait", { timeout: 60000 });
    } finally {
      console.log = origLog;
    }
  });

  test("prints session list on timeout fallback", async () => {
    // When the daemon falls back to session list on timeout, the result is a session list
    const callTool = mock(async () => toolResult(SESSION_LIST));
    const deps = makeDeps({ callTool });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["wait", "--timeout", "1000"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_wait", { timeout: 1000 });
      // Output should contain the session list JSON
      const output = (logSpy.mock.calls[0] as string[])[0];
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].sessionId).toBe(SESSION_LIST[0].sessionId);
    } finally {
      console.log = origLog;
    }
  });
});

// ── lifecycle ──

describe("mcx claude lifecycle (spawn → ls → send → log → bye)", () => {
  test("exercises full session lifecycle with stateful mock", async () => {
    // Stateful mock: tracks sessions and transcript across calls
    const sessions: Array<{
      sessionId: string;
      state: string;
      model: string;
      cwd: string;
      cost: number;
      tokens: number;
      numTurns: number;
      pendingPermissions: number;
      worktree: string | null;
    }> = [];
    const transcript: Array<{
      timestamp: number;
      direction: string;
      message: { type: string; message?: { role: string; content: string } };
    }> = [];

    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string, args: Record<string, unknown>) => {
      switch (tool) {
        case "claude_prompt": {
          if (!args.sessionId) {
            // spawn — create a new session
            const sessionId = "lifecycle-1111-2222-3333-444444444444";
            sessions.push({
              sessionId,
              state: "active",
              model: "opus-4",
              cwd: "/tmp",
              cost: 0.01,
              tokens: 500,
              numTurns: 1,
              pendingPermissions: 0,
              worktree: null,
            });
            transcript.push({
              timestamp: Date.now(),
              direction: "outbound",
              message: { type: "user", message: { role: "user", content: args.prompt as string } },
            });
            transcript.push({
              timestamp: Date.now() + 1,
              direction: "inbound",
              message: { type: "assistant", message: { role: "assistant", content: "Done." } },
            });
            return toolResult({ sessionId, success: true, cost: 0.01 });
          }
          // send — follow-up on existing session
          const s = sessions.find((sess) => sess.sessionId === args.sessionId);
          if (s) {
            s.numTurns++;
            s.tokens += 200;
            s.cost += 0.005;
          }
          transcript.push({
            timestamp: Date.now() + 10,
            direction: "outbound",
            message: { type: "user", message: { role: "user", content: args.prompt as string } },
          });
          transcript.push({
            timestamp: Date.now() + 11,
            direction: "inbound",
            message: { type: "assistant", message: { role: "assistant", content: "Follow-up done." } },
          });
          return toolResult({ success: true, cost: 0.005 });
        }
        case "claude_session_list":
          return toolResult(sessions);
        case "claude_transcript":
          return toolResult(transcript.slice(-(args.limit as number)));
        case "claude_bye": {
          const idx = sessions.findIndex((sess) => sess.sessionId === args.sessionId);
          if (idx >= 0) sessions[idx].state = "ended";
          return toolResult({ ended: true });
        }
        default:
          return toolResult({ error: `unknown tool: ${tool}` });
      }
    });

    const deps = makeDeps({ callTool });

    // Capture console.log / console.error output
    const logSpy = mock(() => {});
    const errSpy = mock(() => {});
    const origLog = console.log;
    const origErr = console.error;
    console.log = logSpy;
    console.error = errSpy;

    try {
      // 1. Spawn
      await cmdClaude(["spawn", "--task", "lifecycle test"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_prompt", { prompt: "lifecycle test" });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].state).toBe("active");

      // 2. List — verify the new session appears
      logSpy.mockClear();
      await cmdClaude(["ls"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_session_list", {});
      // Header row + 1 session row
      expect(logSpy.mock.calls.length).toBe(2);
      const row = (logSpy.mock.calls[1] as string[])[0];
      expect(row).toContain("lifecycl"); // first 8 chars of session ID

      // 3. Send a follow-up
      logSpy.mockClear();
      await cmdClaude(["send", "lifecycle", "follow up message"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_prompt", {
        sessionId: "lifecycle-1111-2222-3333-444444444444",
        prompt: "follow up message",
      });
      expect(sessions[0].numTurns).toBe(2);

      // 4. View transcript
      logSpy.mockClear();
      await cmdClaude(["log", "lifecycle"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_transcript", {
        sessionId: "lifecycle-1111-2222-3333-444444444444",
        limit: 20,
      });
      // Should print formatted entries (at least 4 transcript entries)
      expect(logSpy.mock.calls.length).toBeGreaterThanOrEqual(4);

      // 5. Bye — end the session
      logSpy.mockClear();
      await cmdClaude(["bye", "lifecycle"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_bye", {
        sessionId: "lifecycle-1111-2222-3333-444444444444",
      });
      expect(sessions[0].state).toBe("ended");
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });
});

// ── extractContentSummary ──

describe("extractContentSummary", () => {
  test("returns plain string as-is", () => {
    expect(extractContentSummary("hello")).toBe("hello");
  });

  test("extracts text from text content blocks", () => {
    const content = [{ type: "text", text: "Hello world" }];
    expect(extractContentSummary(content)).toBe("Hello world");
  });

  test("summarizes tool_use blocks", () => {
    const content = [{ type: "tool_use", name: "Read", id: "123", input: {} }];
    expect(extractContentSummary(content)).toBe("[tool_use: Read]");
  });

  test("handles tool_result with string content", () => {
    const content = [{ type: "tool_result", tool_use_id: "123", content: "file contents here" }];
    expect(extractContentSummary(content)).toBe("file contents here");
  });

  test("handles tool_result with non-string content", () => {
    const content = [{ type: "tool_result", tool_use_id: "123", content: [{ type: "text", text: "x" }] }];
    expect(extractContentSummary(content)).toBe("[tool_result]");
  });

  test("joins multiple blocks", () => {
    const content = [
      { type: "text", text: "Let me read that." },
      { type: "tool_use", name: "Read", id: "1", input: {} },
    ];
    expect(extractContentSummary(content)).toBe("Let me read that. [tool_use: Read]");
  });

  test("returns null for non-array non-string", () => {
    expect(extractContentSummary(42)).toBeNull();
    expect(extractContentSummary(null)).toBeNull();
    expect(extractContentSummary(undefined)).toBeNull();
  });

  test("returns null for empty array", () => {
    expect(extractContentSummary([])).toBeNull();
  });
});

// ── parseWorktreeList ──

describe("parseWorktreeList", () => {
  test("parses porcelain output with branches", () => {
    const output = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.claude/worktrees/claude-abc",
      "HEAD def456",
      "branch refs/heads/feat/issue-42",
      "",
    ].join("\n");
    const result = parseWorktreeList(output);
    expect(result).toEqual([
      { path: "/repo", branch: "main" },
      { path: "/repo/.claude/worktrees/claude-abc", branch: "feat/issue-42" },
    ]);
  });

  test("handles detached HEAD (no branch)", () => {
    const output = ["worktree /repo", "HEAD abc123", "detached", ""].join("\n");
    const result = parseWorktreeList(output);
    expect(result).toEqual([{ path: "/repo", branch: null }]);
  });

  test("returns empty array for empty output", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

// ── bye branch cleanup ──

describe("mcx claude bye branch cleanup", () => {
  test("deletes merged branch after worktree removal", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ ended: true, worktree: "claude-abc123", cwd: "/repo" });
    });
    const exec: ClaudeDeps["exec"] = mock((cmd: string[]) => {
      if (cmd.includes("status")) return { stdout: "", exitCode: 0 };
      if (cmd.includes("--show-current")) return { stdout: "feat/issue-42", exitCode: 0 };
      if (cmd.includes("remove")) return { stdout: "", exitCode: 0 };
      if (cmd.includes("-d")) return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def"], deps);
      // Should have called branch -d
      const branchCalls = (exec as ReturnType<typeof mock>).mock.calls.filter((c: unknown[]) =>
        (c[0] as string[]).includes("-d"),
      );
      expect(branchCalls.length).toBe(1);
      expect(branchCalls[0][0]).toContain("feat/issue-42");
      const errOutput = printError.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(errOutput).toContain("Deleted branch: feat/issue-42 (merged)");
    } finally {
      console.log = origLog;
    }
  });

  test("silently keeps unmerged branch (git branch -d fails)", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ ended: true, worktree: "claude-abc123", cwd: "/repo" });
    });
    const exec: ClaudeDeps["exec"] = mock((cmd: string[]) => {
      if (cmd.includes("status")) return { stdout: "", exitCode: 0 };
      if (cmd.includes("--show-current")) return { stdout: "feat/unmerged", exitCode: 0 };
      if (cmd.includes("remove")) return { stdout: "", exitCode: 0 };
      if (cmd.includes("-d")) return { stdout: "", exitCode: 1 }; // unmerged
      return { stdout: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def"], deps);
      const errOutput = printError.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(errOutput).toContain("Removed worktree:");
      expect(errOutput).not.toContain("Deleted branch:");
    } finally {
      console.log = origLog;
    }
  });

  test("skips branch delete when no branch detected", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ ended: true, worktree: "claude-abc123", cwd: "/repo" });
    });
    const exec: ClaudeDeps["exec"] = mock((cmd: string[]) => {
      if (cmd.includes("status")) return { stdout: "", exitCode: 0 };
      if (cmd.includes("--show-current")) return { stdout: "", exitCode: 0 }; // detached HEAD
      if (cmd.includes("remove")) return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def"], deps);
      // Should NOT call git branch -d
      const branchCalls = (exec as ReturnType<typeof mock>).mock.calls.filter((c: unknown[]) =>
        (c[0] as string[]).includes("-d"),
      );
      expect(branchCalls.length).toBe(0);
    } finally {
      console.log = origLog;
    }
  });
});

// ── worktrees ──

describe("mcx claude worktrees", () => {
  test("lists worktrees with session status", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") {
        // SessionInfo.worktree is a bare name (not a full path)
        return toolResult([{ ...SESSION_LIST[0], worktree: "claude-active" }]);
      }
      return toolResult({});
    });
    const exec: ClaudeDeps["exec"] = mock((cmd: string[]) => {
      if (cmd.includes("list") && cmd.includes("--porcelain")) {
        const cwd = process.cwd();
        return {
          stdout: [
            `worktree ${cwd}`,
            "HEAD abc123",
            "branch refs/heads/main",
            "",
            `worktree ${cwd}/.claude/worktrees/claude-active`,
            "HEAD def456",
            "branch refs/heads/feat/active",
            "",
            `worktree ${cwd}/.claude/worktrees/claude-orphan`,
            "HEAD 789abc",
            "branch refs/heads/feat/orphan",
            "",
          ].join("\n"),
          exitCode: 0,
        };
      }
      if (cmd.includes("status")) return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const deps = makeDeps({ callTool, exec });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["worktrees"], deps);
      // Header + 2 worktree rows (main repo excluded)
      expect(logSpy.mock.calls.length).toBe(3);
      const output = (logSpy.mock.calls as string[][]).map((c) => c[0]).join("\n");
      expect(output).toContain("claude-active");
      expect(output).toContain("claude-orphan");
      // Verify session status is shown correctly
      expect(output).toContain("active"); // session column for claude-active
    } finally {
      console.log = origLog;
    }
  });

  test("prune removes clean orphaned worktrees", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async () => toolResult([]));
    const cwd = process.cwd();
    const exec: ClaudeDeps["exec"] = mock((cmd: string[]) => {
      if (cmd.includes("list") && cmd.includes("--porcelain")) {
        return {
          stdout: [
            `worktree ${cwd}`,
            "HEAD abc123",
            "branch refs/heads/main",
            "",
            `worktree ${cwd}/.claude/worktrees/claude-orphan`,
            "HEAD 789abc",
            "branch refs/heads/feat/orphan",
            "",
          ].join("\n"),
          exitCode: 0,
        };
      }
      if (cmd.includes("status")) return { stdout: "", exitCode: 0 };
      if (cmd.includes("remove")) return { stdout: "", exitCode: 0 };
      if (cmd.includes("-d")) return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["worktrees", "--prune"], deps);
      const errOutput = printError.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(errOutput).toContain("Removed worktree:");
      expect(errOutput).toContain("Deleted branch: feat/orphan (merged)");
      expect(errOutput).toContain("Pruned 1 worktree.");
    } finally {
      console.log = origLog;
    }
  });

  test("prune skips worktrees with active sessions", async () => {
    const cwd = process.cwd();
    // Session with bare worktree name matching "claude-active"
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") {
        return toolResult([{ ...SESSION_LIST[0], worktree: "claude-active" }]);
      }
      return toolResult({});
    });
    const exec: ClaudeDeps["exec"] = mock((cmd: string[]) => {
      if (cmd.includes("list") && cmd.includes("--porcelain")) {
        return {
          stdout: [
            `worktree ${cwd}`,
            "HEAD abc123",
            "branch refs/heads/main",
            "",
            `worktree ${cwd}/.claude/worktrees/claude-active`,
            "HEAD def456",
            "branch refs/heads/feat/active",
            "",
          ].join("\n"),
          exitCode: 0,
        };
      }
      if (cmd.includes("status")) return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["worktrees", "--prune"], deps);
      const errOutput = printError.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(errOutput).toContain("Nothing to prune.");
      // Should NOT call git worktree remove
      const removeCalls = (exec as ReturnType<typeof mock>).mock.calls.filter((c: unknown[]) =>
        (c[0] as string[]).includes("remove"),
      );
      expect(removeCalls.length).toBe(0);
    } finally {
      console.log = origLog;
    }
  });

  test("prune skips dirty worktrees", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async () => toolResult([]));
    const cwd = process.cwd();
    const exec: ClaudeDeps["exec"] = mock((cmd: string[]) => {
      if (cmd.includes("list") && cmd.includes("--porcelain")) {
        return {
          stdout: [
            `worktree ${cwd}`,
            "HEAD abc123",
            "branch refs/heads/main",
            "",
            `worktree ${cwd}/.claude/worktrees/claude-dirty`,
            "HEAD 789abc",
            "branch refs/heads/feat/dirty",
            "",
          ].join("\n"),
          exitCode: 0,
        };
      }
      if (cmd.includes("status")) return { stdout: " M file.ts", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["worktrees", "--prune"], deps);
      const errOutput = printError.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(errOutput).toContain("Nothing to prune.");
    } finally {
      console.log = origLog;
    }
  });

  test("reports no worktrees when none exist", async () => {
    const exec: ClaudeDeps["exec"] = mock((cmd: string[]) => {
      if (cmd.includes("list") && cmd.includes("--porcelain")) {
        const cwd = process.cwd();
        return {
          stdout: `worktree ${cwd}\nHEAD abc123\nbranch refs/heads/main\n`,
          exitCode: 0,
        };
      }
      return { stdout: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const deps = makeDeps({ exec, printError });

    await cmdClaude(["worktrees"], deps);
    const errOutput = printError.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(errOutput).toContain("No mcx worktrees found.");
  });

  test("accepts 'wt' alias", async () => {
    const exec: ClaudeDeps["exec"] = mock((cmd: string[]) => {
      if (cmd.includes("list") && cmd.includes("--porcelain")) {
        const cwd = process.cwd();
        return {
          stdout: `worktree ${cwd}\nHEAD abc123\nbranch refs/heads/main\n`,
          exitCode: 0,
        };
      }
      return { stdout: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const deps = makeDeps({ exec, printError });

    await cmdClaude(["wt"], deps);
    const errOutput = printError.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(errOutput).toContain("No mcx worktrees found.");
  });
});
