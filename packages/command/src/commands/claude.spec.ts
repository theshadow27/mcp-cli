import { describe, expect, mock, test } from "bun:test";
import type { ClaudeDeps } from "./claude";
import { cmdClaude, parseLogArgs, parseSpawnArgs, resolveSessionId } from "./claude";

// ── Helpers ──

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

function makeDeps(overrides?: Partial<ClaudeDeps>): ClaudeDeps {
  return {
    callTool: mock(async () => ({ content: [{ type: "text", text: "[]" }] })),
    printError: mock(() => {}),
    exit: mock((code: number) => {
      throw new ExitError(code);
    }) as ClaudeDeps["exit"],
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
  },
];

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

  test("errors on non-numeric --last", () => {
    const result = parseLogArgs(["abc123", "--last", "abc"]);
    expect(result.error).toBe("--last must be a number");
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
});

// ── kill ──

describe("mcx claude kill", () => {
  test("interrupts resolved session", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ interrupted: true });
    });
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["kill", "def"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_interrupt", {
        sessionId: "def67890-aaaa-bbbb-cccc-dddddddddddd",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("errors when no session specified", async () => {
    const deps = makeDeps();
    await expect(cmdClaude(["kill"], deps)).rejects.toThrow(ExitError);
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

  test("errors when no session specified", async () => {
    const deps = makeDeps();
    await expect(cmdClaude(["log"], deps)).rejects.toThrow(ExitError);
  });
});
