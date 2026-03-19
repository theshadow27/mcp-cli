import { describe, expect, mock, test } from "bun:test";
import { getProvider } from "@mcp-cli/core";
import { ExitError } from "../test-helpers";
import type { AgentDeps } from "./agent";
import { cmdAgent, parseAgentSpawnArgs } from "./agent";

// ── Helpers ──

/** Assert a provider exists and return it (avoids non-null assertions). */
function requireProvider(name: string) {
  const p = getProvider(name);
  if (!p) throw new Error(`Provider ${name} not found`);
  return p;
}

function makeDeps(overrides?: Partial<AgentDeps>): AgentDeps {
  return {
    callTool: mock(async () => ({ content: [{ type: "text", text: "[]" }] })),
    printError: mock(() => {}),
    exit: mock((code: number) => {
      throw new ExitError(code);
    }) as AgentDeps["exit"],
    getStaleDaemonWarning: mock(() => null),
    getGitRoot: mock(() => null),
    getDiffStats: mock(async () => null),
    getPrStatus: mock(async () => null),
    ttyOpen: mock(async () => {}),
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

// ── Top-level dispatch ──

describe("cmdAgent", () => {
  test("prints usage on --help", async () => {
    const log = mock(() => {});
    const origLog = console.log;
    console.log = log;
    try {
      await cmdAgent(["--help"]);
      expect(log).toHaveBeenCalled();
      const output = (log.mock.calls[0] as string[])[0];
      expect(output).toContain("mcx agent");
      expect(output).toContain("claude");
      expect(output).toContain("codex");
    } finally {
      console.log = origLog;
    }
  });

  test("prints usage on no args", async () => {
    const log = mock(() => {});
    const origLog = console.log;
    console.log = log;
    try {
      await cmdAgent([]);
      expect(log).toHaveBeenCalled();
    } finally {
      console.log = origLog;
    }
  });

  test("rejects unknown provider", async () => {
    const deps = makeDeps();
    await expect(cmdAgent(["bogus", "ls"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Unknown provider"));
  });

  test("prints provider usage when no subcommand", async () => {
    const log = mock(() => {});
    const origLog = console.log;
    console.log = log;
    try {
      const deps = makeDeps();
      await cmdAgent(["codex"], deps);
      expect(log).toHaveBeenCalled();
      const output = (log.mock.calls[0] as string[])[0];
      expect(output).toContain("mcx agent codex");
    } finally {
      console.log = origLog;
    }
  });

  test("rejects unknown subcommand", async () => {
    const deps = makeDeps();
    await expect(cmdAgent(["codex", "bogus"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Unknown codex subcommand"));
  });
});

// ── parseAgentSpawnArgs ──

describe("parseAgentSpawnArgs", () => {
  const codexConfig = requireProvider("codex");
  const claudeConfig = requireProvider("claude");
  const acpConfig = requireProvider("acp");
  const opencodeConfig = requireProvider("opencode");

  test("parses --task flag", () => {
    const result = parseAgentSpawnArgs(["--task", "fix bug"], codexConfig);
    expect(result.task).toBe("fix bug");
    expect(result.error).toBeUndefined();
  });

  test("parses --json flag", () => {
    const result = parseAgentSpawnArgs(["--task", "x", "--json"], codexConfig);
    expect(result.json).toBe(true);
  });

  test("parses --worktree with auto-name for provider", () => {
    const result = parseAgentSpawnArgs(["--worktree", "--task", "x"], codexConfig);
    expect(result.worktree).toMatch(/^codex-/);
  });

  test("parses --headed for Claude", () => {
    const result = parseAgentSpawnArgs(["--task", "x", "--headed"], claudeConfig);
    expect(result.headed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("rejects --headed for Codex", () => {
    const result = parseAgentSpawnArgs(["--task", "x", "--headed"], codexConfig);
    expect(result.error).toContain("--headed is not supported");
  });

  test("parses --agent for ACP", () => {
    const result = parseAgentSpawnArgs(["--task", "x", "--agent", "copilot"], acpConfig);
    expect(result.agent).toBe("copilot");
    expect(result.error).toBeUndefined();
  });

  test("rejects --agent for Codex", () => {
    const result = parseAgentSpawnArgs(["--task", "x", "--agent", "copilot"], codexConfig);
    expect(result.error).toContain("--agent is not supported");
  });

  test("parses --provider for OpenCode", () => {
    const result = parseAgentSpawnArgs(["--task", "x", "--provider", "openai"], opencodeConfig);
    expect(result.provider).toBe("openai");
    expect(result.error).toBeUndefined();
  });

  test("rejects --provider for Claude", () => {
    const result = parseAgentSpawnArgs(["--task", "x", "--provider", "openai"], claudeConfig);
    expect(result.error).toContain("--provider is not supported");
  });

  test("uses agentOverride for ACP aliases", () => {
    const result = parseAgentSpawnArgs(["--task", "x"], acpConfig, "copilot");
    expect(result.agent).toBe("copilot");
  });
});

// ── Codex via agent ──

describe("agent codex spawn", () => {
  test("calls codex_prompt with task", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1", state: "active" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAgent(["codex", "spawn", "--task", "do stuff"], deps);
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
      await cmdAgent(["codex", "spawn", "--task", "do stuff", "--wait"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_prompt", expect.objectContaining({ wait: true }));
    } finally {
      console.log = origLog;
    }
  });

  test("errors without task", async () => {
    const deps = makeDeps();
    await expect(cmdAgent(["codex", "spawn"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  test("passes worktree name to daemon", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAgent(["codex", "spawn", "--task", "x", "--worktree", "my-wt"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_prompt", expect.objectContaining({ worktree: "my-wt" }));
    } finally {
      console.log = origLog;
    }
  });
});

describe("agent codex ls", () => {
  test("calls codex_session_list", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAgent(["codex", "ls"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_session_list", {});
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
      await cmdAgent(["codex", "ls", "--short"], deps);
      expect(logCalls.length).toBe(2);
      expect(logCalls[0]).toContain("abc12345");
    } finally {
      console.log = origLog;
    }
  });

  test("shows empty message when no sessions", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult([])),
    });
    const errCalls: string[] = [];
    const origErr = console.error;
    console.error = mock((...args: unknown[]) => errCalls.push(String(args[0])));
    try {
      await cmdAgent(["codex", "ls"], deps);
      expect(errCalls.some((l) => l.includes("No active"))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });
});

describe("agent codex send", () => {
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
      await cmdAgent(["codex", "send", "abc12345", "hello world"], deps);
      expect(deps.callTool).toHaveBeenCalledWith(
        "codex_prompt",
        expect.objectContaining({ sessionId: SESSION_LIST[0].sessionId, prompt: "hello world" }),
      );
    } finally {
      console.log = origLog;
    }
  });

  test("errors without session and message", async () => {
    const deps = makeDeps();
    await expect(cmdAgent(["codex", "send"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });
});

describe("agent codex bye", () => {
  test("calls codex_bye with resolved sessionId", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return toolResult({ ended: true, worktree: null, cwd: null, repoRoot: null });
      }),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAgent(["codex", "bye", "abc12345"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_bye", { sessionId: SESSION_LIST[0].sessionId });
    } finally {
      console.log = origLog;
    }
  });
});

describe("agent codex interrupt", () => {
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
      await cmdAgent(["codex", "interrupt", "abc12345"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_interrupt", { sessionId: SESSION_LIST[0].sessionId });
    } finally {
      console.log = origLog;
    }
  });
});

describe("agent codex log", () => {
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
      await cmdAgent(["codex", "log", "abc12345"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_transcript", {
        sessionId: SESSION_LIST[0].sessionId,
        limit: 20,
      });
    } finally {
      console.log = origLog;
    }
  });
});

describe("agent codex wait", () => {
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
      await cmdAgent(["codex", "wait", "abc12345"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_wait", { sessionId: SESSION_LIST[0].sessionId });
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
      await cmdAgent(["codex", "wait", "--timeout", "5000"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_wait", { timeout: 5000 });
    } finally {
      console.log = origLog;
    }
  });
});

// ── ACP via agent ──

describe("agent acp spawn", () => {
  test("calls acp_prompt with agent and task", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1", state: "active" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAgent(["acp", "spawn", "--agent", "copilot", "--task", "do stuff"], deps);
      expect(deps.callTool).toHaveBeenCalledWith(
        "acp_prompt",
        expect.objectContaining({ prompt: "do stuff", agent: "copilot" }),
      );
    } finally {
      console.log = origLog;
    }
  });

  test("errors without --agent for ACP", async () => {
    const deps = makeDeps();
    await expect(cmdAgent(["acp", "spawn", "--task", "x"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("--agent is required"));
  });
});

// ── Copilot alias via agent ──

describe("agent copilot", () => {
  test("resolves to ACP with copilot agent override", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1", state: "active" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAgent(["copilot", "spawn", "--task", "do stuff"], deps);
      expect(deps.callTool).toHaveBeenCalledWith(
        "acp_prompt",
        expect.objectContaining({ prompt: "do stuff", agent: "copilot" }),
      );
    } finally {
      console.log = origLog;
    }
  });

  test("copilot ls calls acp_session_list with agent filter", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult([])),
    });
    const origErr = console.error;
    console.error = mock(() => {});
    try {
      await cmdAgent(["copilot", "ls"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("acp_session_list", { agent: "copilot" });
    } finally {
      console.error = origErr;
    }
  });
});

// ── Claude via agent ──

describe("agent claude spawn", () => {
  test("calls claude_prompt with task", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1", state: "active" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAgent(["claude", "spawn", "--task", "do stuff"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("claude_prompt", expect.objectContaining({ prompt: "do stuff" }));
    } finally {
      console.log = origLog;
    }
  });
});

describe("agent claude ls", () => {
  test("passes repoRoot for repo-scoped filtering", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult([])),
      getGitRoot: mock(() => "/repo/root"),
    });
    const origErr = console.error;
    console.error = mock(() => {});
    try {
      await cmdAgent(["claude", "ls"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("claude_session_list", { repoRoot: "/repo/root" });
    } finally {
      console.error = origErr;
    }
  });
});

// ── OpenCode via agent ──

describe("agent opencode spawn", () => {
  test("passes --provider flag to tool args", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1", state: "active" })),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdAgent(["opencode", "spawn", "--task", "x", "--provider", "openai"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("opencode_prompt", expect.objectContaining({ provider: "openai" }));
    } finally {
      console.log = origLog;
    }
  });
});

// ── Resume/worktrees delegation ──

describe("agent resume/worktrees", () => {
  test("rejects resume for non-Claude providers", async () => {
    const deps = makeDeps();
    await expect(cmdAgent(["codex", "resume", "wt-1"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("does not support resume"));
  });

  test("delegates worktrees to Claude message", async () => {
    const deps = makeDeps();
    await expect(cmdAgent(["codex", "worktrees"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("mcx claude worktrees"));
  });
});
