import { describe, expect, mock, test } from "bun:test";
import { ExitError } from "../test-helpers";
import type { AcpDeps } from "./acp";
import { cmdAcp, parseAcpSpawnArgs } from "./acp";

// ── Helpers ──

function makeDeps(overrides?: Partial<AcpDeps>): AcpDeps {
  return {
    callTool: mock(async () => ({ content: [{ type: "text", text: "[]" }] })),
    printError: mock(() => {}),
    exit: mock((code: number) => {
      throw new ExitError(code);
    }) as AcpDeps["exit"],
    getStaleDaemonWarning: mock(() => null),
    getGitRoot: mock(() => null),
    getPrStatus: mock(async () => null),
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
    provider: "acp",
    agent: "copilot",
    state: "active",
    model: "gpt-4o",
    cwd: "/tmp",
    cost: null,
    tokens: 1000,
    numTurns: 3,
    worktree: null,
    processAlive: true,
  },
  {
    sessionId: "def67890-aaaa-bbbb-cccc-dddddddddddd",
    provider: "acp",
    agent: "gemini",
    state: "idle",
    model: "gemini-pro",
    cwd: "/home",
    cost: null,
    tokens: 500,
    numTurns: 1,
    worktree: null,
    processAlive: true,
  },
];

// ── parseAcpSpawnArgs ──

describe("parseAcpSpawnArgs", () => {
  test("parses --agent flag", () => {
    const result = parseAcpSpawnArgs(["--agent", "copilot", "--task", "fix bug"]);
    expect(result.agent).toBe("copilot");
    expect(result.task).toBe("fix bug");
    expect(result.error).toBeUndefined();
  });

  test("parses -a shorthand for agent", () => {
    const result = parseAcpSpawnArgs(["-a", "gemini", "--task", "x"]);
    expect(result.agent).toBe("gemini");
  });

  test("uses agentOverride when provided", () => {
    const result = parseAcpSpawnArgs(["--task", "fix bug"], "copilot");
    expect(result.agent).toBe("copilot");
  });

  test("agentOverride ignores --agent flag", () => {
    const result = parseAcpSpawnArgs(["--agent", "gemini", "--task", "fix bug"], "copilot");
    expect(result.agent).toBe("copilot");
  });

  test("errors on missing --agent value", () => {
    const result = parseAcpSpawnArgs(["--agent", "--task", "x"]);
    expect(result.error).toBe("--agent requires a value (e.g. copilot, gemini)");
  });

  test("parses --task flag", () => {
    const result = parseAcpSpawnArgs(["--agent", "copilot", "--task", "fix bug"]);
    expect(result.task).toBe("fix bug");
  });

  test("parses -t shorthand", () => {
    const result = parseAcpSpawnArgs(["-a", "copilot", "-t", "fix bug"]);
    expect(result.task).toBe("fix bug");
  });

  test("parses positional task", () => {
    const result = parseAcpSpawnArgs(["--agent", "copilot", "fix the tests"]);
    expect(result.task).toBe("fix the tests");
  });

  test("parses --allow with multiple tools", () => {
    const result = parseAcpSpawnArgs(["--agent", "copilot", "--allow", "Read", "Glob", "--task", "x"]);
    expect(result.allow).toEqual(["Read", "Glob"]);
  });

  test("parses --wait flag", () => {
    const result = parseAcpSpawnArgs(["--agent", "copilot", "--task", "x", "--wait"]);
    expect(result.wait).toBe(true);
  });

  test("parses --json flag", () => {
    const result = parseAcpSpawnArgs(["--agent", "copilot", "--task", "x", "--json"]);
    expect(result.json).toBe(true);
  });

  test("json defaults to false", () => {
    const result = parseAcpSpawnArgs(["--agent", "copilot", "--task", "x"]);
    expect(result.json).toBe(false);
  });

  test("parses --worktree with name", () => {
    const result = parseAcpSpawnArgs(["--agent", "copilot", "--worktree", "my-branch", "--task", "x"]);
    expect(result.worktree).toBe("my-branch");
  });

  test("parses -w shorthand", () => {
    const result = parseAcpSpawnArgs(["-a", "copilot", "-w", "my-branch", "--task", "x"]);
    expect(result.worktree).toBe("my-branch");
  });

  test("auto-generates worktree name when no value given", () => {
    const result = parseAcpSpawnArgs(["--agent", "copilot", "--worktree", "--task", "x"]);
    expect(result.worktree).toMatch(/^acp-/);
  });

  test("worktree defaults to undefined", () => {
    const result = parseAcpSpawnArgs(["--agent", "copilot", "--task", "x"]);
    expect(result.worktree).toBeUndefined();
  });

  test("parses --model flag", () => {
    const result = parseAcpSpawnArgs(["--agent", "copilot", "--model", "sonnet", "--task", "x"]);
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  test("errors on missing --task value", () => {
    const result = parseAcpSpawnArgs(["--agent", "copilot", "--task"]);
    expect(result.error).toBe("--task requires a value");
  });

  test("errors on non-numeric --timeout", () => {
    const result = parseAcpSpawnArgs(["--agent", "copilot", "--timeout", "abc"]);
    expect(result.error).toBe("--timeout must be a number");
  });
});

// ── cmdAcp — subcommand dispatch ──

describe("cmdAcp", () => {
  test("prints usage on --help", async () => {
    const log = mock(() => {});
    const origLog = console.log;
    console.log = log;
    try {
      const deps = makeDeps();
      await cmdAcp(["--help"], undefined, deps);
      expect(log).toHaveBeenCalled();
      const output = (log.mock.calls[0] as string[])[0];
      expect(output).toContain("mcx acp");
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
      await cmdAcp([], undefined, deps);
      expect(log).toHaveBeenCalled();
    } finally {
      console.log = origLog;
    }
  });

  test("rejects unknown subcommand", async () => {
    const deps = makeDeps();
    await expect(cmdAcp(["bogus"], undefined, deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Unknown acp subcommand"));
  });

  test("uses agent name in error when agentOverride set", async () => {
    const deps = makeDeps();
    await expect(cmdAcp(["bogus"], "copilot", deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Unknown copilot subcommand"));
  });

  test("help shows agent name when agentOverride set", async () => {
    const log = mock(() => {});
    const origLog = console.log;
    console.log = log;
    try {
      const deps = makeDeps();
      await cmdAcp(["--help"], "copilot", deps);
      expect(log).toHaveBeenCalled();
      const output = (log.mock.calls[0] as string[])[0];
      expect(output).toContain("mcx copilot");
    } finally {
      console.log = origLog;
    }
  });
});

// ── spawn ──

describe("acp spawn", () => {
  test("prints spawn usage on --help", async () => {
    const log = mock(() => {});
    const origLog = console.log;
    console.log = log;
    try {
      const deps = makeDeps();
      await cmdAcp(["spawn", "--help"], undefined, deps);
      expect(log).toHaveBeenCalled();
      const output = (log.mock.calls[0] as string[])[0];
      expect(output).toContain("mcx acp spawn");
    } finally {
      console.log = origLog;
    }
  });

  test("prints agent-specific spawn usage on --help with agentOverride", async () => {
    const log = mock(() => {});
    const origLog = console.log;
    console.log = log;
    try {
      const deps = makeDeps();
      await cmdAcp(["spawn", "--help"], "copilot", deps);
      expect(log).toHaveBeenCalled();
      const output = (log.mock.calls[0] as string[])[0];
      expect(output).toContain("mcx copilot spawn");
    } finally {
      console.log = origLog;
    }
  });

  test("reports parse errors", async () => {
    const deps = makeDeps();
    await expect(cmdAcp(["spawn", "--agent", "copilot", "--timeout", "abc"], undefined, deps)).rejects.toThrow(
      ExitError,
    );
    expect(deps.printError).toHaveBeenCalledWith("--timeout must be a number");
  });

  test("calls acp_prompt with task and agent", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1", state: "active" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAcp(["spawn", "--agent", "copilot", "--task", "do stuff"], undefined, deps);
      expect(deps.callTool).toHaveBeenCalledWith(
        "acp_prompt",
        expect.objectContaining({ prompt: "do stuff", agent: "copilot" }),
      );
    } finally {
      console.log = origLog;
    }
  });

  test("copilot wrapper sets agent automatically", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1", state: "active" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAcp(["spawn", "--task", "do stuff"], "copilot", deps);
      expect(deps.callTool).toHaveBeenCalledWith(
        "acp_prompt",
        expect.objectContaining({ prompt: "do stuff", agent: "copilot" }),
      );
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
      await cmdAcp(["spawn", "--agent", "copilot", "--task", "x", "--wait"], undefined, deps);
      expect(deps.callTool).toHaveBeenCalledWith("acp_prompt", expect.objectContaining({ wait: true }));
    } finally {
      console.log = origLog;
    }
  });

  test("errors without --agent when no agentOverride", async () => {
    const deps = makeDeps();
    await expect(cmdAcp(["spawn", "--task", "do stuff"], undefined, deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("--agent is required"));
  });

  test("errors without task", async () => {
    const deps = makeDeps();
    await expect(cmdAcp(["spawn", "--agent", "copilot"], undefined, deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  test("--json outputs raw JSON", async () => {
    const spawnResult = { sessionId: "s1-full-uuid", state: "active" };
    const deps = makeDeps({
      callTool: mock(async () => toolResult(spawnResult)),
    });
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => logCalls.push(String(args[0])));
    try {
      await cmdAcp(["spawn", "--agent", "copilot", "--task", "x", "--json"], undefined, deps);
      const parsed = JSON.parse(logCalls.join(""));
      expect(parsed.sessionId).toBe("s1-full-uuid");
    } finally {
      console.log = origLog;
    }
  });

  test("prints agent-capitalized session info to stderr", async () => {
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
      await cmdAcp(["spawn", "--agent", "copilot", "--task", "x"], undefined, deps);
      expect(errCalls.some((l) => l.includes("Copilot session started"))).toBe(true);
      expect(errCalls.some((l) => l.includes("abc12345"))).toBe(true);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });

  test("passes worktree name to daemon", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAcp(["spawn", "--agent", "copilot", "--task", "x", "--worktree", "my-wt"], undefined, deps);
      expect(deps.callTool).toHaveBeenCalledWith("acp_prompt", expect.objectContaining({ worktree: "my-wt" }));
    } finally {
      console.log = origLog;
    }
  });
});

// ── ls ──

describe("acp ls", () => {
  test("outputs short format with --short", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => logCalls.push(String(args[0])));
    try {
      await cmdAcp(["ls", "--short"], undefined, deps);
      expect(logCalls.length).toBe(2);
      expect(logCalls[0]).toContain("abc12345");
      expect(logCalls[1]).toContain("def67890");
    } finally {
      console.log = origLog;
    }
  });

  test("calls acp_session_list", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAcp(["ls"], undefined, deps);
      expect(deps.callTool).toHaveBeenCalledWith("acp_session_list", {});
    } finally {
      console.log = origLog;
    }
  });

  test("passes agent filter when agentOverride set", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult([SESSION_LIST[0]])),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAcp(["ls"], "copilot", deps);
      expect(deps.callTool).toHaveBeenCalledWith("acp_session_list", { agent: "copilot" });
    } finally {
      console.log = origLog;
    }
  });

  test("passes --agent filter from args", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult([SESSION_LIST[1]])),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAcp(["ls", "--agent", "gemini"], undefined, deps);
      expect(deps.callTool).toHaveBeenCalledWith("acp_session_list", { agent: "gemini" });
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
      await cmdAcp(["ls", "--json"], undefined, deps);
      expect(() => JSON.parse(logCalls.join(""))).not.toThrow();
    } finally {
      console.log = origLog;
    }
  });

  test("shows AGENT column when no agentOverride", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => logCalls.push(String(args[0])));
    try {
      await cmdAcp(["ls"], undefined, deps);
      // Header should contain AGENT
      expect(logCalls[0]).toContain("AGENT");
    } finally {
      console.log = origLog;
    }
  });

  test("hides AGENT column when agentOverride set", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult([SESSION_LIST[0]])),
    });
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => logCalls.push(String(args[0])));
    try {
      await cmdAcp(["ls"], "copilot", deps);
      // Header should not contain AGENT
      expect(logCalls[0]).not.toContain("AGENT");
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
      await cmdAcp(["ls"], undefined, deps);
      expect(errCalls.some((l) => l.includes("No active ACP sessions"))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });

  test("prints agent-specific empty message when agentOverride set", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult([])),
    });
    const errCalls: string[] = [];
    const origErr = console.error;
    console.error = mock((...args: unknown[]) => errCalls.push(String(args[0])));
    try {
      await cmdAcp(["ls"], "copilot", deps);
      expect(errCalls.some((l) => l.includes("No active copilot sessions"))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });
});

// ── send ──

describe("acp send", () => {
  test("calls acp_prompt with sessionId and prompt", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "acp_session_list") return toolResult(SESSION_LIST);
        return toolResult({ ok: true });
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAcp(["send", "abc12345", "hello world"], undefined, deps);
      expect(deps.callTool).toHaveBeenCalledWith(
        "acp_prompt",
        expect.objectContaining({ sessionId: SESSION_LIST[0].sessionId, prompt: "hello world" }),
      );
    } finally {
      console.log = origLog;
    }
  });

  test("errors without session and message", async () => {
    const deps = makeDeps();
    await expect(cmdAcp(["send"], undefined, deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });
});

// ── bye ──

describe("acp bye", () => {
  test("calls acp_bye with resolved sessionId", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "acp_session_list") return toolResult(SESSION_LIST);
        return toolResult({ ended: true, worktree: null, cwd: null, repoRoot: null });
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAcp(["bye", "abc12345"], undefined, deps);
      expect(deps.callTool).toHaveBeenCalledWith("acp_bye", { sessionId: SESSION_LIST[0].sessionId });
    } finally {
      console.log = origLog;
    }
  });

  test("errors without session id", async () => {
    const deps = makeDeps();
    await expect(cmdAcp(["bye"], undefined, deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  test("triggers worktree cleanup when bye returns worktree metadata", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "acp_session_list") return toolResult(SESSION_LIST);
        return toolResult({ ended: true, worktree: "my-wt", cwd: "/tmp/wt/my-wt", repoRoot: "/tmp/repo" });
      }),
      exec: mock(() => ({ stdout: "", stderr: "", exitCode: 0 })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAcp(["bye", "abc12345"], undefined, deps);
      expect(deps.exec).toHaveBeenCalled();
    } finally {
      console.log = origLog;
    }
  });
});

// ── interrupt ──

describe("acp interrupt", () => {
  test("calls acp_interrupt", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "acp_session_list") return toolResult(SESSION_LIST);
        return toolResult({ ok: true });
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAcp(["interrupt", "abc12345"], undefined, deps);
      expect(deps.callTool).toHaveBeenCalledWith("acp_interrupt", { sessionId: SESSION_LIST[0].sessionId });
    } finally {
      console.log = origLog;
    }
  });

  test("errors without session id", async () => {
    const deps = makeDeps();
    await expect(cmdAcp(["interrupt"], undefined, deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });
});

// ── log ──

describe("acp log", () => {
  test("outputs JSON with --json flag", async () => {
    const entries = [{ timestamp: 1000, direction: "outbound", message: { type: "user" } }];
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "acp_session_list") return toolResult(SESSION_LIST);
        return toolResult(entries);
      }),
    });
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => logCalls.push(String(args[0])));
    try {
      await cmdAcp(["log", "abc12345", "--json"], undefined, deps);
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
        if (tool === "acp_session_list") return toolResult(SESSION_LIST);
        return toolResult(entries);
      }),
    });
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => logCalls.push(String(args[0])));
    try {
      await cmdAcp(["log", "abc12345"], undefined, deps);
      expect(logCalls.some((l) => l.includes("user"))).toBe(true);
      expect(logCalls.some((l) => l.includes("assistant"))).toBe(true);
      expect(logCalls.some((l) => l.includes("result"))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  test("passes --last flag", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "acp_session_list") return toolResult(SESSION_LIST);
        return toolResult([]);
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAcp(["log", "abc12345", "--last", "5"], undefined, deps);
      expect(deps.callTool).toHaveBeenCalledWith("acp_transcript", {
        sessionId: SESSION_LIST[0].sessionId,
        limit: 5,
      });
    } finally {
      console.log = origLog;
    }
  });

  test("calls acp_transcript", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "acp_session_list") return toolResult(SESSION_LIST);
        return toolResult([]);
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAcp(["log", "abc12345"], undefined, deps);
      expect(deps.callTool).toHaveBeenCalledWith("acp_transcript", {
        sessionId: SESSION_LIST[0].sessionId,
        limit: 20,
      });
    } finally {
      console.log = origLog;
    }
  });

  test("errors without session prefix", async () => {
    const deps = makeDeps();
    await expect(cmdAcp(["log"], undefined, deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });
});

// ── wait ──

describe("acp wait", () => {
  test("calls acp_wait with sessionId", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "acp_session_list") return toolResult(SESSION_LIST);
        return toolResult({ event: "session:result", sessionId: SESSION_LIST[0].sessionId });
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAcp(["wait", "abc12345"], undefined, deps);
      expect(deps.callTool).toHaveBeenCalledWith("acp_wait", { sessionId: SESSION_LIST[0].sessionId });
    } finally {
      console.log = origLog;
    }
  });

  test("calls acp_wait without sessionId for global wait", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ event: "session:result" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAcp(["wait"], undefined, deps);
      expect(deps.callTool).toHaveBeenCalledWith("acp_wait", {});
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
      await cmdAcp(["wait", "--timeout", "5000"], undefined, deps);
      expect(deps.callTool).toHaveBeenCalledWith("acp_wait", { timeout: 5000 });
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
      await cmdAcp(["wait", "--after", "42"], undefined, deps);
      expect(deps.callTool).toHaveBeenCalledWith("acp_wait", { afterSeq: 42 });
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
      await cmdAcp(["wait", "--short"], undefined, deps);
      expect(logCalls.length).toBe(1);
      expect(logCalls[0]).toContain("abc12345");
      expect(logCalls[0]).toContain("session:result");
      expect(logCalls[0]).toContain("N/A");
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
      await cmdAcp(["wait", "--short"], undefined, deps);
      expect(logCalls.length).toBe(2);
    } finally {
      console.log = origLog;
    }
  });
});
