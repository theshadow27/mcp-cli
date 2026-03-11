import { describe, expect, mock, test } from "bun:test";
import { ExitError } from "../test-helpers";
import type { CodexDeps } from "./codex";
import { cmdCodex, parseCodexSpawnArgs } from "./codex";

// ── Helpers ──

function makeDeps(overrides?: Partial<CodexDeps>): CodexDeps {
  return {
    callTool: mock(async () => ({ content: [{ type: "text", text: "[]" }] })),
    printError: mock(() => {}),
    exit: mock((code: number) => {
      throw new ExitError(code);
    }) as CodexDeps["exit"],
    getDiffStats: mock(async () => null),
    getPrStatus: mock(async () => null),
    exec: mock(() => ({ stdout: "", stderr: "", exitCode: 0 })),
    ttyOpen: mock(async () => {}),
    ...overrides,
  };
}

function toolResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

const SESSION_LIST = [
  {
    sessionId: "abc12345-1111-2222-3333-444444444444",
    provider: "codex",
    state: "active",
    model: "o3",
    cwd: "/tmp",
    cost: null,
    tokens: 1000,
    reasoningTokens: 200,
    numTurns: 3,
    pendingPermissions: 0,
    pendingPermissionDetails: [],
    worktree: null,
    processAlive: true,
  },
  {
    sessionId: "def67890-aaaa-bbbb-cccc-dddddddddddd",
    provider: "codex",
    state: "idle",
    model: "o4-mini",
    cwd: "/home",
    cost: null,
    tokens: 500,
    reasoningTokens: 100,
    numTurns: 1,
    pendingPermissions: 0,
    pendingPermissionDetails: [],
    worktree: null,
    processAlive: true,
  },
];

// ── parseCodexSpawnArgs ──

describe("parseCodexSpawnArgs", () => {
  test("parses --task flag", () => {
    const result = parseCodexSpawnArgs(["--task", "fix bug"]);
    expect(result.task).toBe("fix bug");
    expect(result.error).toBeUndefined();
  });

  test("parses -t shorthand", () => {
    const result = parseCodexSpawnArgs(["-t", "fix bug"]);
    expect(result.task).toBe("fix bug");
  });

  test("parses positional task", () => {
    const result = parseCodexSpawnArgs(["fix the tests"]);
    expect(result.task).toBe("fix the tests");
  });

  test("parses --worktree with name", () => {
    const result = parseCodexSpawnArgs(["--worktree", "my-feature", "--task", "x"]);
    expect(result.worktree).toBe("my-feature");
  });

  test("parses --worktree without name (auto-generates)", () => {
    const result = parseCodexSpawnArgs(["--worktree", "--task", "x"]);
    expect(result.worktree).toBeDefined();
    expect(result.worktree).toStartWith("codex-");
  });

  test("parses --allow with multiple tools", () => {
    const result = parseCodexSpawnArgs(["--allow", "Read", "Glob", "Grep", "--task", "x"]);
    expect(result.allow).toEqual(["Read", "Glob", "Grep"]);
  });

  test("parses --wait flag", () => {
    const result = parseCodexSpawnArgs(["--task", "fix bug", "--wait"]);
    expect(result.wait).toBe(true);
  });

  test("parses --model with shortname", () => {
    const result = parseCodexSpawnArgs(["--model", "sonnet", "--task", "x"]);
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  test("errors on missing --task value", () => {
    const result = parseCodexSpawnArgs(["--task"]);
    expect(result.error).toBe("--task requires a value");
  });

  test("errors on non-numeric --timeout", () => {
    const result = parseCodexSpawnArgs(["--timeout", "abc"]);
    expect(result.error).toBe("--timeout must be a number");
  });

  test("errors on empty --allow", () => {
    const result = parseCodexSpawnArgs(["--allow", "--task", "x"]);
    expect(result.error).toBe("--allow requires at least one tool pattern");
  });

  test("parses --cwd flag", () => {
    const result = parseCodexSpawnArgs(["--cwd", "/tmp/work", "--task", "x"]);
    expect(result.cwd).toBe("/tmp/work");
  });

  test("parses --timeout flag", () => {
    const result = parseCodexSpawnArgs(["--timeout", "60000", "--task", "x"]);
    expect(result.timeout).toBe(60000);
  });

  test("parses -w shorthand", () => {
    const result = parseCodexSpawnArgs(["-w", "feat", "-t", "x"]);
    expect(result.worktree).toBe("feat");
  });

  test("-m shorthand works", () => {
    const result = parseCodexSpawnArgs(["-m", "haiku", "-t", "x"]);
    expect(result.model).toBe("claude-haiku-4-5-20251001");
  });

  test("errors on missing --model value", () => {
    const result = parseCodexSpawnArgs(["--model"]);
    expect(result.error).toBe("--model requires a value");
  });

  test("errors on missing --cwd value", () => {
    const result = parseCodexSpawnArgs(["--cwd"]);
    expect(result.error).toBe("--cwd requires a path");
  });

  test("errors on missing --timeout value", () => {
    const result = parseCodexSpawnArgs(["--timeout"]);
    expect(result.error).toBe("--timeout requires a value in ms");
  });

  test("wait defaults to false", () => {
    const result = parseCodexSpawnArgs(["--task", "x"]);
    expect(result.wait).toBe(false);
  });
});

// ── cmdCodex — subcommand dispatch ──

describe("cmdCodex", () => {
  test("prints usage on --help", async () => {
    const log = mock(() => {});
    const origLog = console.log;
    console.log = log;
    try {
      const deps = makeDeps();
      await cmdCodex(["--help"], deps);
      expect(log).toHaveBeenCalled();
      const output = (log.mock.calls[0] as string[])[0];
      expect(output).toContain("mcx codex");
    } finally {
      console.log = origLog;
    }
  });

  test("prints usage on no subcommand", async () => {
    const log = mock(() => {});
    const origLog = console.log;
    console.log = log;
    try {
      const deps = makeDeps();
      await cmdCodex([], deps);
      expect(log).toHaveBeenCalled();
    } finally {
      console.log = origLog;
    }
  });

  test("rejects unknown subcommand", async () => {
    const deps = makeDeps();
    await expect(cmdCodex(["bogus"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Unknown codex subcommand"));
  });
});

// ── spawn ──

describe("codex spawn", () => {
  test("calls codex_prompt with task", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1", state: "active" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdCodex(["spawn", "--task", "do stuff"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_prompt", expect.objectContaining({ prompt: "do stuff" }));
    } finally {
      console.log = origLog;
    }
  });

  test("passes --wait flag", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdCodex(["spawn", "--task", "do stuff", "--wait"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_prompt", expect.objectContaining({ wait: true }));
    } finally {
      console.log = origLog;
    }
  });

  test("errors without task", async () => {
    const deps = makeDeps();
    await expect(cmdCodex(["spawn"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  test("passes --model flag", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdCodex(["spawn", "--task", "x", "--model", "o3"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_prompt", expect.objectContaining({ model: "o3" }));
    } finally {
      console.log = origLog;
    }
  });

  test("passes --allow tools", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdCodex(["spawn", "--task", "x", "--allow", "Read", "Write"], deps);
      expect(deps.callTool).toHaveBeenCalledWith(
        "codex_prompt",
        expect.objectContaining({ allowedTools: ["Read", "Write"] }),
      );
    } finally {
      console.log = origLog;
    }
  });

  test("passes --cwd and --timeout", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdCodex(["spawn", "--task", "x", "--cwd", "/tmp", "--timeout", "10000"], deps);
      expect(deps.callTool).toHaveBeenCalledWith(
        "codex_prompt",
        expect.objectContaining({ cwd: "/tmp", timeout: 10000 }),
      );
    } finally {
      console.log = origLog;
    }
  });

  test("reports parse errors", async () => {
    const deps = makeDeps();
    await expect(cmdCodex(["spawn", "--timeout", "abc"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith("--timeout must be a number");
  });

  test("passes --worktree without hooks", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdCodex(["spawn", "--task", "x", "--worktree", "my-wt"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_prompt", expect.objectContaining({ worktree: "my-wt" }));
    } finally {
      console.log = origLog;
    }
  });
});

// ── ls ──

describe("codex ls", () => {
  test("calls codex_session_list", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdCodex(["ls"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_session_list", {});
    } finally {
      console.log = origLog;
    }
  });

  test("shows N/A for cost in table output", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => logCalls.push(String(args[0])));
    try {
      await cmdCodex(["ls"], deps);
      // Session rows should contain N/A for cost
      const sessionRows = logCalls.filter((l) => l.includes("abc12345".slice(0, 8)));
      expect(sessionRows.length).toBeGreaterThan(0);
      expect(sessionRows[0]).toContain("N/A");
    } finally {
      console.log = origLog;
    }
  });

  test("outputs JSON with --json flag", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => logCalls.push(String(args[0])));
    try {
      await cmdCodex(["ls", "--json"], deps);
      // Should output raw JSON
      const output = logCalls.join("");
      expect(() => JSON.parse(output)).not.toThrow();
    } finally {
      console.log = origLog;
    }
  });

  test("outputs short format with --short", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => logCalls.push(String(args[0])));
    try {
      await cmdCodex(["ls", "--short"], deps);
      expect(logCalls.length).toBe(2); // One line per session
      expect(logCalls[0]).toContain("abc12345");
      expect(logCalls[1]).toContain("def67890");
    } finally {
      console.log = origLog;
    }
  });

  test("prints empty message when no sessions", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult([])),
    });
    const errCalls: string[] = [];
    const origErr = console.error;
    console.error = mock((...args: unknown[]) => errCalls.push(String(args[0])));
    try {
      await cmdCodex(["ls"], deps);
      expect(errCalls.some((l) => l.includes("No active Codex sessions"))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });
});

// ── send ──

describe("codex send", () => {
  test("calls codex_prompt with sessionId and prompt", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return toolResult({ ok: true });
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdCodex(["send", "abc12345", "hello world"], deps);
      expect(deps.callTool).toHaveBeenCalledWith(
        "codex_prompt",
        expect.objectContaining({ sessionId: SESSION_LIST[0].sessionId, prompt: "hello world" }),
      );
    } finally {
      console.log = origLog;
    }
  });

  test("passes --wait flag", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return toolResult({ ok: true });
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdCodex(["send", "--wait", "abc12345", "hello"], deps);
      expect(deps.callTool).toHaveBeenCalledWith(
        "codex_prompt",
        expect.objectContaining({ wait: true, prompt: "hello" }),
      );
    } finally {
      console.log = origLog;
    }
  });

  test("errors without session and message", async () => {
    const deps = makeDeps();
    await expect(cmdCodex(["send"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });
});

// ── bye ──

describe("codex bye", () => {
  test("calls codex_bye with resolved sessionId", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return toolResult({ sessionId: SESSION_LIST[0].sessionId, worktree: null, cwd: null });
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdCodex(["bye", "abc12345"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_bye", { sessionId: SESSION_LIST[0].sessionId });
    } finally {
      console.log = origLog;
    }
  });

  test("errors without session id", async () => {
    const deps = makeDeps();
    await expect(cmdCodex(["bye"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });
});

// ── interrupt ──

describe("codex interrupt", () => {
  test("calls codex_interrupt", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return toolResult({ ok: true });
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdCodex(["interrupt", "abc12345"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_interrupt", { sessionId: SESSION_LIST[0].sessionId });
    } finally {
      console.log = origLog;
    }
  });
});

// ── interrupt ── (additional)

describe("codex interrupt (errors)", () => {
  test("errors without session id", async () => {
    const deps = makeDeps();
    await expect(cmdCodex(["interrupt"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });
});

// ── log ──

describe("codex log", () => {
  test("calls codex_transcript", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return toolResult([]);
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdCodex(["log", "abc12345"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_transcript", {
        sessionId: SESSION_LIST[0].sessionId,
        limit: 20,
      });
    } finally {
      console.log = origLog;
    }
  });

  test("passes --last flag", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return toolResult([]);
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdCodex(["log", "abc12345", "--last", "5"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_transcript", {
        sessionId: SESSION_LIST[0].sessionId,
        limit: 5,
      });
    } finally {
      console.log = origLog;
    }
  });

  test("errors without session prefix", async () => {
    const deps = makeDeps();
    await expect(cmdCodex(["log"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  test("outputs JSON with --json flag", async () => {
    const entries = [{ timestamp: 1000, direction: "outbound", message: { type: "user" } }];
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return toolResult(entries);
      }),
    });
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => logCalls.push(String(args[0])));
    try {
      await cmdCodex(["log", "abc12345", "--json"], deps);
      expect(() => JSON.parse(logCalls.join(""))).not.toThrow();
    } finally {
      console.log = origLog;
    }
  });

  test("formats transcript entries", async () => {
    const entries = [
      {
        timestamp: Date.now(),
        direction: "outbound",
        message: { type: "user", message: { content: "hello" } },
      },
      {
        timestamp: Date.now(),
        direction: "inbound",
        message: { type: "assistant", message: { content: "hi there" } },
      },
      {
        timestamp: Date.now(),
        direction: "inbound",
        message: { type: "result", result: "done" },
      },
    ];
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return toolResult(entries);
      }),
    });
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => logCalls.push(String(args[0])));
    try {
      await cmdCodex(["log", "abc12345"], deps);
      // Should have lines for each entry type + content
      expect(logCalls.some((l) => l.includes("user"))).toBe(true);
      expect(logCalls.some((l) => l.includes("assistant"))).toBe(true);
      expect(logCalls.some((l) => l.includes("result"))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });
});

// ── wait ──

describe("codex wait", () => {
  test("calls codex_wait with sessionId", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return toolResult({ event: "session:result", sessionId: SESSION_LIST[0].sessionId });
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdCodex(["wait", "abc12345"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_wait", { sessionId: SESSION_LIST[0].sessionId });
    } finally {
      console.log = origLog;
    }
  });

  test("calls codex_wait without sessionId for global wait", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ event: "session:result" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdCodex(["wait"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_wait", {});
    } finally {
      console.log = origLog;
    }
  });

  test("passes --timeout flag", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ event: "timeout" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdCodex(["wait", "--timeout", "5000"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_wait", { timeout: 5000 });
    } finally {
      console.log = origLog;
    }
  });

  test("passes --after flag", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ event: "session:result" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdCodex(["wait", "--after", "42"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_wait", { afterSeq: 42 });
    } finally {
      console.log = origLog;
    }
  });

  test("--short formats event result", async () => {
    const deps = makeDeps({
      callTool: mock(async () =>
        toolResult({
          sessionId: "abc12345-1111-2222-3333-444444444444",
          event: "session:result",
          cost: null,
          numTurns: 5,
          result: "completed the task",
        }),
      ),
    });
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => logCalls.push(String(args[0])));
    try {
      await cmdCodex(["wait", "--short"], deps);
      expect(logCalls.length).toBe(1);
      expect(logCalls[0]).toContain("abc12345");
      expect(logCalls[0]).toContain("session:result");
      expect(logCalls[0]).toContain("N/A"); // cost is null
    } finally {
      console.log = origLog;
    }
  });

  test("--short formats session list fallback", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => logCalls.push(String(args[0])));
    try {
      await cmdCodex(["wait", "--short"], deps);
      expect(logCalls.length).toBe(2); // One line per session
    } finally {
      console.log = origLog;
    }
  });
});
