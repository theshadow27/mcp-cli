import { describe, expect, mock, test } from "bun:test";
import type { ClaudeDeps } from "./claude";
import { cmdClaude, parseLogArgs, parseSpawnArgs, parseWaitArgs, resolveSessionId } from "./claude";

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

  test("parses --wait flag", () => {
    const result = parseSpawnArgs(["--task", "fix bug", "--wait"]);
    expect(result.wait).toBe(true);
    expect(result.task).toBe("fix bug");
  });

  test("wait defaults to false", () => {
    const result = parseSpawnArgs(["--task", "fix bug"]);
    expect(result.wait).toBe(false);
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
