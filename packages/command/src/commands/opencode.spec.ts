import { describe, expect, mock, test } from "bun:test";
import { ExitError } from "../test-helpers";
import type { OpencodeDeps } from "./opencode";
import { cmdOpencode, parseOpencodeSpawnArgs } from "./opencode";

// ── Helpers ──

function makeDeps(overrides?: Partial<OpencodeDeps>): OpencodeDeps {
  return {
    callTool: mock(async () => ({ content: [{ type: "text", text: "[]" }] })),
    printError: mock(() => {}),
    exit: mock((code: number) => {
      throw new ExitError(code);
    }) as OpencodeDeps["exit"],
    getStaleDaemonWarning: mock(() => null),
    exec: mock(() => ({ stdout: "", stderr: "", exitCode: 0 })),
    ...overrides,
  };
}

function toolResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

const SESSION_LIST = [
  {
    sessionId: "abc12345-1111-2222-3333-444444444444",
    provider: "opencode",
    state: "active",
    model: "grok-3",
    cwd: "/tmp",
    cost: 0.0523,
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
    provider: "opencode",
    state: "idle",
    model: "gemini-2.5-pro",
    cwd: "/home",
    cost: 0.0012,
    tokens: 500,
    reasoningTokens: 100,
    numTurns: 1,
    pendingPermissions: 0,
    pendingPermissionDetails: [],
    worktree: null,
    processAlive: true,
  },
];

// ── parseOpencodeSpawnArgs ──

describe("parseOpencodeSpawnArgs", () => {
  test("parses --task flag", () => {
    const result = parseOpencodeSpawnArgs(["--task", "fix bug"]);
    expect(result.task).toBe("fix bug");
    expect(result.error).toBeUndefined();
  });

  test("parses -t shorthand", () => {
    const result = parseOpencodeSpawnArgs(["-t", "fix bug"]);
    expect(result.task).toBe("fix bug");
  });

  test("parses positional task", () => {
    const result = parseOpencodeSpawnArgs(["fix the tests"]);
    expect(result.task).toBe("fix the tests");
  });

  test("parses --allow with multiple tools", () => {
    const result = parseOpencodeSpawnArgs(["--allow", "Read", "Glob", "Grep", "--task", "x"]);
    expect(result.allow).toEqual(["Read", "Glob", "Grep"]);
  });

  test("parses --wait flag", () => {
    const result = parseOpencodeSpawnArgs(["--task", "fix bug", "--wait"]);
    expect(result.wait).toBe(true);
  });

  test("parses --model flag", () => {
    const result = parseOpencodeSpawnArgs(["--model", "grok-3", "--task", "x"]);
    expect(result.model).toBe("grok-3");
  });

  test("parses --provider flag", () => {
    const result = parseOpencodeSpawnArgs(["--provider", "xai", "--task", "x"]);
    expect(result.provider).toBe("xai");
  });

  test("parses -p shorthand for provider", () => {
    const result = parseOpencodeSpawnArgs(["-p", "google", "--task", "x"]);
    expect(result.provider).toBe("google");
  });

  test("errors on missing --provider value", () => {
    const result = parseOpencodeSpawnArgs(["--provider", "--task", "x"]);
    expect(result.error).toContain("--provider requires a value");
  });

  test("errors on missing --task value", () => {
    const result = parseOpencodeSpawnArgs(["--task"]);
    expect(result.error).toBe("--task requires a value");
  });

  test("errors on non-numeric --timeout", () => {
    const result = parseOpencodeSpawnArgs(["--timeout", "abc"]);
    expect(result.error).toBe("--timeout must be a number");
  });

  test("parses --json flag", () => {
    const result = parseOpencodeSpawnArgs(["--task", "fix bug", "--json"]);
    expect(result.json).toBe(true);
  });

  test("json defaults to false", () => {
    const result = parseOpencodeSpawnArgs(["--task", "x"]);
    expect(result.json).toBe(false);
  });

  test("parses --worktree with name", () => {
    const result = parseOpencodeSpawnArgs(["--worktree", "my-branch", "--task", "x"]);
    expect(result.worktree).toBe("my-branch");
  });

  test("parses -w shorthand with name", () => {
    const result = parseOpencodeSpawnArgs(["-w", "my-branch", "--task", "x"]);
    expect(result.worktree).toBe("my-branch");
  });

  test("auto-generates worktree name when no value given", () => {
    const result = parseOpencodeSpawnArgs(["--worktree", "--task", "x"]);
    expect(result.worktree).toMatch(/^opencode-/);
  });

  test("auto-generates worktree name at end of args", () => {
    const result = parseOpencodeSpawnArgs(["--task", "x", "-w"]);
    expect(result.worktree).toMatch(/^opencode-/);
  });

  test("worktree defaults to undefined", () => {
    const result = parseOpencodeSpawnArgs(["--task", "x"]);
    expect(result.worktree).toBeUndefined();
  });

  test("provider defaults to undefined", () => {
    const result = parseOpencodeSpawnArgs(["--task", "x"]);
    expect(result.provider).toBeUndefined();
  });
});

// ── cmdOpencode — subcommand dispatch ──

describe("cmdOpencode", () => {
  test("prints usage on --help", async () => {
    const log = mock(() => {});
    const origLog = console.log;
    console.log = log;
    try {
      const deps = makeDeps();
      await cmdOpencode(["--help"], deps);
      expect(log).toHaveBeenCalled();
      const output = (log.mock.calls[0] as string[])[0];
      expect(output).toContain("mcx opencode");
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
      await cmdOpencode([], deps);
      expect(log).toHaveBeenCalled();
    } finally {
      console.log = origLog;
    }
  });

  test("rejects unknown subcommand", async () => {
    const deps = makeDeps();
    await expect(cmdOpencode(["bogus"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Unknown opencode subcommand"));
  });

  test("fails fast when daemon build is stale", async () => {
    const deps = makeDeps({
      getStaleDaemonWarning: mock(() => "Daemon is running a different build. Run `mcx shutdown`."),
    });
    await expect(cmdOpencode(["spawn", "--task", "x"], deps)).rejects.toThrow(ExitError);
    expect(deps.callTool).not.toHaveBeenCalled();
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("mcx shutdown"));
  });
});

// ── spawn ──

describe("opencode spawn", () => {
  test("calls opencode_prompt with task", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1", state: "active" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdOpencode(["spawn", "--task", "do stuff"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("opencode_prompt", expect.objectContaining({ prompt: "do stuff" }));
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
      await cmdOpencode(["spawn", "--task", "do stuff", "--wait"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("opencode_prompt", expect.objectContaining({ wait: true }));
    } finally {
      console.log = origLog;
    }
  });

  test("errors without task", async () => {
    const deps = makeDeps();
    await expect(cmdOpencode(["spawn"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  test("passes --model flag", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdOpencode(["spawn", "--task", "x", "--model", "grok-3"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("opencode_prompt", expect.objectContaining({ model: "grok-3" }));
    } finally {
      console.log = origLog;
    }
  });

  test("passes --provider flag", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdOpencode(["spawn", "--task", "x", "--provider", "xai"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("opencode_prompt", expect.objectContaining({ provider: "xai" }));
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
      await cmdOpencode(["spawn", "--task", "x", "--allow", "Read", "Write"], deps);
      expect(deps.callTool).toHaveBeenCalledWith(
        "opencode_prompt",
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
      await cmdOpencode(["spawn", "--task", "x", "--cwd", "/tmp", "--timeout", "10000"], deps);
      expect(deps.callTool).toHaveBeenCalledWith(
        "opencode_prompt",
        expect.objectContaining({ cwd: "/tmp", timeout: 10000 }),
      );
    } finally {
      console.log = origLog;
    }
  });

  test("reports parse errors", async () => {
    const deps = makeDeps();
    await expect(cmdOpencode(["spawn", "--timeout", "abc"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith("--timeout must be a number");
  });

  test("--json outputs raw JSON to stdout", async () => {
    const spawnResult = { sessionId: "s1-full-uuid", state: "active" };
    const deps = makeDeps({
      callTool: mock(async () => toolResult(spawnResult)),
    });
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => logCalls.push(String(args[0])));
    try {
      await cmdOpencode(["spawn", "--task", "do stuff", "--json"], deps);
      const output = logCalls.join("");
      const parsed = JSON.parse(output);
      expect(parsed.sessionId).toBe("s1-full-uuid");
    } finally {
      console.log = origLog;
    }
  });

  test("--json suppresses human-friendly stderr", async () => {
    const spawnResult = { sessionId: "s1-full-uuid", state: "active" };
    const deps = makeDeps({
      callTool: mock(async () => toolResult(spawnResult)),
    });
    const errCalls: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = mock(() => {});
    console.error = mock((...args: unknown[]) => errCalls.push(String(args[0])));
    try {
      await cmdOpencode(["spawn", "--task", "do stuff", "--json"], deps);
      expect(errCalls.filter((l) => l.includes("OpenCode session started"))).toHaveLength(0);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });

  test("without --json prints human-friendly session info to stderr", async () => {
    const spawnResult = { sessionId: "abc12345-full-uuid", state: "active" };
    const deps = makeDeps({
      callTool: mock(async () => toolResult(spawnResult)),
    });
    const errCalls: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = mock(() => {});
    console.error = mock((...args: unknown[]) => errCalls.push(String(args[0])));
    try {
      await cmdOpencode(["spawn", "--task", "do stuff"], deps);
      expect(errCalls.some((l) => l.includes("abc12345"))).toBe(true);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });

  test("passes worktree name to daemon when no hooks or branchPrefix config", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdOpencode(["spawn", "--task", "x", "--worktree", "my-wt"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("opencode_prompt", expect.objectContaining({ worktree: "my-wt" }));
    } finally {
      console.log = origLog;
    }
  });
});

// ── ls ──

describe("opencode ls", () => {
  test("calls opencode_session_list", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdOpencode(["ls"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("opencode_session_list", {});
    } finally {
      console.log = origLog;
    }
  });

  test("shows cost in USD in table output", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => logCalls.push(String(args[0])));
    try {
      await cmdOpencode(["ls"], deps);
      const sessionRows = logCalls.filter((l) => l.includes("abc12345".slice(0, 8)));
      expect(sessionRows.length).toBeGreaterThan(0);
      expect(sessionRows[0]).toContain("$0.0523");
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
      await cmdOpencode(["ls", "--json"], deps);
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
      await cmdOpencode(["ls", "--short"], deps);
      expect(logCalls.length).toBe(2);
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
      await cmdOpencode(["ls"], deps);
      expect(errCalls.some((l) => l.includes("No active OpenCode sessions"))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });
});

// ── send ──

describe("opencode send", () => {
  test("calls opencode_prompt with sessionId and prompt", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "opencode_session_list") return toolResult(SESSION_LIST);
        return toolResult({ ok: true });
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdOpencode(["send", "abc12345", "hello world"], deps);
      expect(deps.callTool).toHaveBeenCalledWith(
        "opencode_prompt",
        expect.objectContaining({ sessionId: SESSION_LIST[0].sessionId, prompt: "hello world" }),
      );
    } finally {
      console.log = origLog;
    }
  });

  test("passes --wait flag", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "opencode_session_list") return toolResult(SESSION_LIST);
        return toolResult({ ok: true });
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdOpencode(["send", "--wait", "abc12345", "hello"], deps);
      expect(deps.callTool).toHaveBeenCalledWith(
        "opencode_prompt",
        expect.objectContaining({ wait: true, prompt: "hello" }),
      );
    } finally {
      console.log = origLog;
    }
  });

  test("errors without session and message", async () => {
    const deps = makeDeps();
    await expect(cmdOpencode(["send"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });
});

// ── bye ──

describe("opencode bye", () => {
  test("calls opencode_bye with resolved sessionId", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "opencode_session_list") return toolResult(SESSION_LIST);
        return toolResult({ ended: true, worktree: null, cwd: null, repoRoot: null });
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdOpencode(["bye", "abc12345"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("opencode_bye", { sessionId: SESSION_LIST[0].sessionId });
    } finally {
      console.log = origLog;
    }
  });

  test("errors without session id", async () => {
    const deps = makeDeps();
    await expect(cmdOpencode(["bye"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  test("triggers worktree cleanup when bye returns worktree metadata", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "opencode_session_list") return toolResult(SESSION_LIST);
        return toolResult({ ended: true, worktree: "my-wt", cwd: "/tmp/wt/my-wt", repoRoot: "/tmp/repo" });
      }),
      exec: mock(() => ({ stdout: "", stderr: "", exitCode: 0 })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdOpencode(["bye", "abc12345"], deps);
      expect(deps.exec).toHaveBeenCalled();
    } finally {
      console.log = origLog;
    }
  });

  test("skips worktree cleanup when bye returns null worktree", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "opencode_session_list") return toolResult(SESSION_LIST);
        return toolResult({ ended: true, worktree: null, cwd: null, repoRoot: null });
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdOpencode(["bye", "abc12345"], deps);
      expect(deps.exec).not.toHaveBeenCalled();
    } finally {
      console.log = origLog;
    }
  });
});

// ── interrupt ──

describe("opencode interrupt", () => {
  test("calls opencode_interrupt", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "opencode_session_list") return toolResult(SESSION_LIST);
        return toolResult({ ok: true });
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdOpencode(["interrupt", "abc12345"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("opencode_interrupt", { sessionId: SESSION_LIST[0].sessionId });
    } finally {
      console.log = origLog;
    }
  });

  test("errors without session id", async () => {
    const deps = makeDeps();
    await expect(cmdOpencode(["interrupt"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });
});

// ── log ──

describe("opencode log", () => {
  test("calls opencode_transcript", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "opencode_session_list") return toolResult(SESSION_LIST);
        return toolResult([]);
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdOpencode(["log", "abc12345"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("opencode_transcript", {
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
        if (tool === "opencode_session_list") return toolResult(SESSION_LIST);
        return toolResult([]);
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdOpencode(["log", "abc12345", "--last", "5"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("opencode_transcript", {
        sessionId: SESSION_LIST[0].sessionId,
        limit: 5,
      });
    } finally {
      console.log = origLog;
    }
  });

  test("errors without session prefix", async () => {
    const deps = makeDeps();
    await expect(cmdOpencode(["log"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  test("outputs JSON with --json flag", async () => {
    const entries = [{ timestamp: 1000, direction: "outbound", message: { type: "user" } }];
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "opencode_session_list") return toolResult(SESSION_LIST);
        return toolResult(entries);
      }),
    });
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => logCalls.push(String(args[0])));
    try {
      await cmdOpencode(["log", "abc12345", "--json"], deps);
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
        if (tool === "opencode_session_list") return toolResult(SESSION_LIST);
        return toolResult(entries);
      }),
    });
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => logCalls.push(String(args[0])));
    try {
      await cmdOpencode(["log", "abc12345"], deps);
      expect(logCalls.some((l) => l.includes("user"))).toBe(true);
      expect(logCalls.some((l) => l.includes("assistant"))).toBe(true);
      expect(logCalls.some((l) => l.includes("result"))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });
});

// ── wait ──

describe("opencode wait", () => {
  test("calls opencode_wait with sessionId", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "opencode_session_list") return toolResult(SESSION_LIST);
        return toolResult({ event: "session:result", sessionId: SESSION_LIST[0].sessionId });
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdOpencode(["wait", "abc12345"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("opencode_wait", { sessionId: SESSION_LIST[0].sessionId });
    } finally {
      console.log = origLog;
    }
  });

  test("calls opencode_wait without sessionId for global wait", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ event: "session:result" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdOpencode(["wait"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("opencode_wait", {});
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
      await cmdOpencode(["wait", "--timeout", "5000"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("opencode_wait", { timeout: 5000 });
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
      await cmdOpencode(["wait", "--after", "42"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("opencode_wait", { afterSeq: 42 });
    } finally {
      console.log = origLog;
    }
  });

  test("--short formats event result with cost", async () => {
    const deps = makeDeps({
      callTool: mock(async () =>
        toolResult({
          sessionId: "abc12345-1111-2222-3333-444444444444",
          event: "session:result",
          cost: 0.0523,
          numTurns: 5,
          result: "completed the task",
        }),
      ),
    });
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => logCalls.push(String(args[0])));
    try {
      await cmdOpencode(["wait", "--short"], deps);
      expect(logCalls.length).toBe(1);
      expect(logCalls[0]).toContain("abc12345");
      expect(logCalls[0]).toContain("session:result");
      expect(logCalls[0]).toContain("$0.0523");
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
      await cmdOpencode(["wait", "--short"], deps);
      expect(logCalls.length).toBe(2);
    } finally {
      console.log = origLog;
    }
  });
});
