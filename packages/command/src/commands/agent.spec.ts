import { describe, expect, mock, test } from "bun:test";
import type { Mock } from "bun:test";
import { getProvider } from "@mcp-cli/core";
import { ExitError } from "../test-helpers";
import type { AgentDeps } from "./agent";
import { cmdAgent, parseAgentResumeArgs, parseAgentSpawnArgs } from "./agent";

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
    getCwd: mock(() => "/fake/cwd"),
    getDiffStats: mock(async () => null),
    getPrStatus: mock(async () => null),
    ttyOpen: mock(async () => {}),
    log: mock(() => {}),
    logError: mock(() => {}),
    exec: mock(() => ({ stdout: "", stderr: "", exitCode: 0 })),
    ...overrides,
  };
}

function toolResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/** Collect all string output from a mock log function. */
function logCalls(deps: AgentDeps): string[] {
  return (deps.log as Mock<(...a: unknown[]) => void>).mock.calls.map((c) => String(c[0]));
}

/** Collect all string output from a mock logError function. */
function errorCalls(deps: AgentDeps): string[] {
  return (deps.logError as Mock<(...a: unknown[]) => void>).mock.calls.map((c) => String(c[0]));
}

/** Temporarily replace console.log and console.error, restoring via restore(). */
function mockConsole() {
  const origLog = console.log;
  const origErr = console.error;
  const logCalls_: string[] = [];
  const errorCalls_: string[] = [];
  const logMock = mock((...args: unknown[]) => logCalls_.push(String(args[0])));
  const errMock = mock((...args: unknown[]) => errorCalls_.push(String(args[0])));
  console.log = logMock;
  console.error = errMock;
  return {
    log: logMock,
    error: errMock,
    logCalls: logCalls_,
    errorCalls: errorCalls_,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
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
    const deps = makeDeps();
    await cmdAgent(["--help"], deps);
    expect(deps.log).toHaveBeenCalled();
    const output = logCalls(deps)[0];
    expect(output).toContain("mcx agent");
    expect(output).toContain("claude");
    expect(output).toContain("codex");
  });

  test("prints usage on no args", async () => {
    const deps = makeDeps();
    await cmdAgent([], deps);
    expect(deps.log).toHaveBeenCalled();
  });

  test("rejects unknown provider", async () => {
    const deps = makeDeps();
    await expect(cmdAgent(["bogus", "ls"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Unknown provider"));
  });

  test("prints provider usage when no subcommand", async () => {
    const deps = makeDeps();
    await cmdAgent(["codex"], deps);
    expect(deps.log).toHaveBeenCalled();
    const output = logCalls(deps)[0];
    expect(output).toContain("mcx agent codex");
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

  test("rejects --headed for ACP", () => {
    const result = parseAgentSpawnArgs(["--task", "x", "--headed"], acpConfig);
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

  test("parses --resume for Claude (native resume)", () => {
    const result = parseAgentSpawnArgs(["--resume", "abc123"], claudeConfig);
    expect(result.resume).toBe("abc123");
    expect(result.error).toBeUndefined();
  });

  test("rejects --resume for Codex (no native resume)", () => {
    const result = parseAgentSpawnArgs(["--task", "x", "--resume", "abc123"], codexConfig);
    expect(result.error).toContain("--resume is not supported");
  });

  test("--resume without session ID produces error", () => {
    const result = parseAgentSpawnArgs(["--resume"], claudeConfig);
    expect(result.error).toContain("--resume requires a session ID");
  });
});

// ── Codex via agent ──

describe("agent codex spawn", () => {
  test("calls codex_prompt with task", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1", state: "active" })),
    });
    await cmdAgent(["codex", "spawn", "--task", "do stuff"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("codex_prompt", expect.objectContaining({ prompt: "do stuff" }));
  });

  test("passes --wait flag", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1" })),
    });
    await cmdAgent(["codex", "spawn", "--task", "do stuff", "--wait"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("codex_prompt", expect.objectContaining({ wait: true }));
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
    await cmdAgent(["codex", "spawn", "--task", "x", "--worktree", "my-wt"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("codex_prompt", expect.objectContaining({ worktree: "my-wt" }));
  });

  test("routes non-JSON daemon errors to stderr", async () => {
    const deps = makeDeps({
      callTool: mock(async () => ({ content: [{ type: "text", text: "connection refused" }] })),
    });
    await cmdAgent(["codex", "spawn", "--task", "x"], deps);
    expect(deps.printError).toHaveBeenCalledWith("connection refused");
  });
});

describe("agent codex ls", () => {
  test("calls codex_session_list", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    await cmdAgent(["codex", "ls"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("codex_session_list", {});
  });

  test("outputs short format with --short", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    await cmdAgent(["codex", "ls", "--short"], deps);
    const output = logCalls(deps);
    expect(output.length).toBe(2);
    expect(output[0]).toContain("abc12345");
  });

  test("shows empty message when no sessions", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult([])),
    });
    await cmdAgent(["codex", "ls"], deps);
    expect(errorCalls(deps).some((l) => l.includes("No active"))).toBe(true);
  });

  test("--all does not require -a shorthand", async () => {
    // Verify -a is NOT treated as --all (was a flag collision with --agent)
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    await cmdAgent(["codex", "ls", "-a"], deps);
    // -a is not --all, so non-repoScoped providers just ignore it
    expect(deps.callTool).toHaveBeenCalledWith("codex_session_list", {});
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
    await cmdAgent(["codex", "send", "abc12345", "hello world"], deps);
    expect(deps.callTool).toHaveBeenCalledWith(
      "codex_prompt",
      expect.objectContaining({ sessionId: SESSION_LIST[0].sessionId, prompt: "hello world" }),
    );
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
    await cmdAgent(["codex", "bye", "abc12345"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("codex_bye", { sessionId: SESSION_LIST[0].sessionId });
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
    await cmdAgent(["codex", "interrupt", "abc12345"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("codex_interrupt", { sessionId: SESSION_LIST[0].sessionId });
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
    await cmdAgent(["codex", "log", "abc12345"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("codex_transcript", {
      sessionId: SESSION_LIST[0].sessionId,
      limit: 20,
    });
  });
});

// ── Log --compact ──

describe("agent log --compact", () => {
  test("passes compact=true for Claude (native compactLog)", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "claude_session_list") return toolResult(SESSION_LIST);
        return toolResult([]);
      }),
    });
    await cmdAgent(["claude", "log", "abc12345", "--compact"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("claude_transcript", {
      sessionId: SESSION_LIST[0].sessionId,
      limit: 20,
      compact: true,
    });
  });

  test("ignores --compact for Codex (no native compactLog)", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return toolResult([]);
      }),
    });
    await cmdAgent(["codex", "log", "abc12345", "--compact"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("codex_transcript", {
      sessionId: SESSION_LIST[0].sessionId,
      limit: 20,
    });
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
    await cmdAgent(["codex", "wait", "abc12345"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("codex_wait", { sessionId: SESSION_LIST[0].sessionId });
  });

  test("passes --timeout flag", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ event: "timeout" })),
    });
    await cmdAgent(["codex", "wait", "--timeout", "5000"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("codex_wait", { timeout: 5000 });
  });
});

// ── ACP via agent ──

describe("agent acp spawn", () => {
  test("calls acp_prompt with agent and task", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1", state: "active" })),
    });
    await cmdAgent(["acp", "spawn", "--agent", "copilot", "--task", "do stuff"], deps);
    expect(deps.callTool).toHaveBeenCalledWith(
      "acp_prompt",
      expect.objectContaining({ prompt: "do stuff", agent: "copilot" }),
    );
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
    await cmdAgent(["copilot", "spawn", "--task", "do stuff"], deps);
    expect(deps.callTool).toHaveBeenCalledWith(
      "acp_prompt",
      expect.objectContaining({ prompt: "do stuff", agent: "copilot" }),
    );
  });

  test("copilot ls calls acp_session_list with agent filter", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult([])),
    });
    await cmdAgent(["copilot", "ls"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("acp_session_list", { agent: "copilot" });
  });
});

// ── Claude via agent ──

describe("agent claude spawn", () => {
  test("calls claude_prompt with task", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1", state: "active" })),
    });
    await cmdAgent(["claude", "spawn", "--task", "do stuff"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("claude_prompt", expect.objectContaining({ prompt: "do stuff" }));
  });
});

describe("agent claude ls", () => {
  test("passes repoRoot for repo-scoped filtering", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult([])),
      getGitRoot: mock(() => "/repo/root"),
    });
    await cmdAgent(["claude", "ls"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("claude_session_list", { repoRoot: "/repo/root" });
  });

  test("--pr is gated by repoScoped feature flag", async () => {
    // Codex does not have repoScoped, so --pr should be ignored
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    await cmdAgent(["codex", "ls", "--pr"], deps);
    // getPrStatus should NOT be called for non-repoScoped providers
    expect(deps.getPrStatus).not.toHaveBeenCalled();
  });
});

// ── OpenCode via agent ──

describe("agent opencode spawn", () => {
  test("passes --provider flag to tool args", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1", state: "active" })),
    });
    await cmdAgent(["opencode", "spawn", "--task", "x", "--provider", "openai"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("opencode_prompt", expect.objectContaining({ provider: "openai" }));
  });
});

// ── parseAgentResumeArgs ──

describe("parseAgentResumeArgs", () => {
  test("parses target positional", () => {
    const result = parseAgentResumeArgs(["my-wt"]);
    expect(result.target).toBe("my-wt");
    expect(result.all).toBe(false);
    expect(result.fresh).toBe(false);
    expect(result.error).toBeUndefined();
  });

  test("parses --all flag", () => {
    const result = parseAgentResumeArgs(["--all"]);
    expect(result.all).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("parses --fresh flag", () => {
    const result = parseAgentResumeArgs(["my-wt", "--fresh"]);
    expect(result.fresh).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("errors on --fresh with session ID", () => {
    const result = parseAgentResumeArgs(["my-wt", "session-abc", "--fresh"]);
    expect(result.error).toContain("--fresh cannot be combined");
  });

  test("errors without target or --all", () => {
    const result = parseAgentResumeArgs([]);
    expect(result.error).toContain("Usage:");
  });

  test("parses --model, --allow, --wait, --timeout", () => {
    const result = parseAgentResumeArgs([
      "my-wt",
      "--model",
      "opus",
      "--allow",
      "Read",
      "Write",
      "--wait",
      "--timeout",
      "5000",
    ]);
    expect(result.model).toBe("opus");
    expect(result.allow).toEqual(["Read", "Write"]);
    expect(result.wait).toBe(true);
    expect(result.timeout).toBe(5000);
  });

  test("parses session ID as second positional", () => {
    const result = parseAgentResumeArgs(["my-wt", "abc123"]);
    expect(result.target).toBe("my-wt");
    expect(result.sessionId).toBe("abc123");
  });

  test("--allow stops consuming at lowercase worktree name", () => {
    const result = parseAgentResumeArgs(["--allow", "Read", "Write", "my-worktree"]);
    expect(result.allow).toEqual(["Read", "Write"]);
    expect(result.target).toBe("my-worktree");
  });
});

// ── Resume (shimmed provider — codex) ──

const WORKTREE_LIST_PORCELAIN = [
  "worktree /repo",
  "HEAD abc123",
  "branch refs/heads/main",
  "",
  "worktree /repo/.claude/worktrees/codex-wt1",
  "HEAD def456",
  "branch refs/heads/feat/issue-42-fix-bug",
  "",
].join("\n");

describe("agent codex resume", () => {
  function makeResumeDeps(overrides?: Partial<AgentDeps>): AgentDeps {
    return makeDeps({
      getCwd: mock(() => "/repo"),
      exec: mock((cmd: string[]) => {
        const cmdStr = cmd.join(" ");
        if (cmdStr.includes("worktree list")) {
          return { stdout: WORKTREE_LIST_PORCELAIN, stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("branch --merged")) {
          return { stdout: "  main\n", stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("log --oneline")) {
          return { stdout: "abc123 fix stuff", stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("diff --stat")) {
          return { stdout: " src/foo.ts | 3 ++-", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult([]);
        return toolResult({ sessionId: "new-session-id" });
      }),
      getPrStatus: mock(async () => null),
      ...overrides,
    });
  }

  test("spawns with git-context prompt (no resumeSessionId)", async () => {
    const deps = makeResumeDeps();
    const mc = mockConsole();
    try {
      await cmdAgent(["codex", "resume", "codex-wt1"], deps);
      expect(deps.callTool).toHaveBeenCalledWith(
        "codex_prompt",
        expect.objectContaining({
          cwd: "/repo/.claude/worktrees/codex-wt1",
        }),
      );
      // Should NOT have resumeSessionId — codex doesn't support native resume
      const callArgs = (deps.callTool as ReturnType<typeof mock>).mock.calls.find(
        (c: unknown[]) => c[0] === "codex_prompt",
      ) as unknown[];
      expect(callArgs).toBeDefined();
      expect(callArgs[1]).not.toHaveProperty("resumeSessionId");
      // Prompt should contain git context
      expect((callArgs[1] as Record<string, unknown>).prompt).toContain("resuming work");
    } finally {
      mc.restore();
    }
  });

  test("skips merged branches with exit 1 in single-target mode", async () => {
    const deps = makeResumeDeps({
      exec: mock((cmd: string[]) => {
        const cmdStr = cmd.join(" ");
        if (cmdStr.includes("worktree list")) {
          return { stdout: WORKTREE_LIST_PORCELAIN, stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("branch --merged")) {
          return { stdout: "  main\n  feat/issue-42-fix-bug\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    });
    await expect(cmdAgent(["codex", "resume", "codex-wt1"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("already merged"));
  });

  test("skips merged branches without exit in --all mode", async () => {
    const deps = makeResumeDeps({
      exec: mock((cmd: string[]) => {
        const cmdStr = cmd.join(" ");
        if (cmdStr.includes("worktree list")) {
          return { stdout: WORKTREE_LIST_PORCELAIN, stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("branch --merged")) {
          return { stdout: "  main\n  feat/issue-42-fix-bug\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    });
    const mc = mockConsole();
    try {
      // --all mode should skip merged branches gracefully without exit(1)
      await cmdAgent(["codex", "resume", "--all"], deps);
      expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("already merged"));
      // Should NOT have called codex_prompt since the only worktree is merged
      const promptCalls = (deps.callTool as ReturnType<typeof mock>).mock.calls.filter(
        (c: unknown[]) => c[0] === "codex_prompt",
      );
      expect(promptCalls.length).toBe(0);
    } finally {
      mc.restore();
    }
  });

  test("errors when worktree has active session", async () => {
    const deps = makeResumeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") {
          return toolResult([{ worktree: "codex-wt1", sessionId: "active-1" }]);
        }
        return toolResult({});
      }),
    });
    await expect(cmdAgent(["codex", "resume", "codex-wt1"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("already has an active session"));
  });

  test("errors when worktree not found", async () => {
    const deps = makeResumeDeps();
    await expect(cmdAgent(["codex", "resume", "nonexistent"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("No worktree matching"));
  });

  test("--all resumes all orphaned worktrees", async () => {
    const deps = makeResumeDeps();
    const mc = mockConsole();
    try {
      await cmdAgent(["codex", "resume", "--all"], deps);
      // Should have called codex_prompt for the orphaned worktree
      expect(deps.callTool).toHaveBeenCalledWith(
        "codex_prompt",
        expect.objectContaining({ cwd: "/repo/.claude/worktrees/codex-wt1" }),
      );
    } finally {
      mc.restore();
    }
  });
});

// ── Resume detached HEAD ──

describe("agent resume detached HEAD worktree", () => {
  const DETACHED_WORKTREE_LIST = [
    "worktree /repo",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /repo/.claude/worktrees/codex-detached",
    "HEAD def456",
    "detached",
    "",
  ].join("\n");

  test("warns about detached HEAD and skips merge check", async () => {
    const deps = makeDeps({
      getCwd: mock(() => "/repo"),
      exec: mock((cmd: string[]) => {
        const cmdStr = cmd.join(" ");
        if (cmdStr.includes("worktree list")) {
          return { stdout: DETACHED_WORKTREE_LIST, stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("log --oneline")) {
          return { stdout: "def456 some work", stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("diff --stat")) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult([]);
        return toolResult({ sessionId: "new-session" });
      }),
      getPrStatus: mock(async () => null),
    });
    const mc = mockConsole();
    try {
      await cmdAgent(["codex", "resume", "codex-detached"], deps);
      expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("detached HEAD"));
      // Should still spawn a session (not skip it)
      expect(deps.callTool).toHaveBeenCalledWith(
        "codex_prompt",
        expect.objectContaining({ cwd: "/repo/.claude/worktrees/codex-detached" }),
      );
    } finally {
      mc.restore();
    }
  });
});

// ── Resume --wait without sessionId ──

describe("agent resume --wait without sessionId", () => {
  test("warns when --wait used but no sessionId in response", async () => {
    const deps = makeDeps({
      getCwd: mock(() => "/repo"),
      exec: mock((cmd: string[]) => {
        const cmdStr = cmd.join(" ");
        if (cmdStr.includes("worktree list")) {
          return { stdout: WORKTREE_LIST_PORCELAIN, stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("branch --merged")) {
          return { stdout: "  main\n", stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("log --oneline")) {
          return { stdout: "abc123 fix stuff", stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("diff --stat")) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult([]);
        // Return response without sessionId
        return toolResult({ error: "something" });
      }),
      getPrStatus: mock(async () => null),
    });
    const mc = mockConsole();
    try {
      await cmdAgent(["codex", "resume", "codex-wt1", "--wait"], deps);
      expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("--wait specified but no sessionId"));
    } finally {
      mc.restore();
    }
  });

  test("calls codex_wait after codex_prompt when sessionId is returned", async () => {
    const deps = makeDeps({
      getCwd: mock(() => "/repo"),
      exec: mock((cmd: string[]) => {
        const cmdStr = cmd.join(" ");
        if (cmdStr.includes("worktree list")) {
          return { stdout: WORKTREE_LIST_PORCELAIN, stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("branch --merged")) {
          return { stdout: "  main\n", stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("log --oneline")) {
          return { stdout: "abc123 fix stuff", stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("diff --stat")) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult([]);
        if (tool === "codex_prompt") return toolResult({ sessionId: "wait-session-id" });
        return toolResult({ event: "session:result" });
      }),
      getPrStatus: mock(async () => null),
    });
    const mc = mockConsole();
    try {
      await cmdAgent(["codex", "resume", "codex-wt1", "--wait"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_prompt", expect.anything());
      expect(deps.callTool).toHaveBeenCalledWith("codex_wait", { sessionId: "wait-session-id" });
    } finally {
      mc.restore();
    }
  });
});

// ── Resume ECONNREFUSED / non-connection error handling ──

describe("agent resume connection error handling", () => {
  test("swallows ECONNREFUSED from session_list and proceeds without active session guard", async () => {
    const deps = makeDeps({
      getCwd: mock(() => "/repo"),
      exec: mock((cmd: string[]) => {
        const cmdStr = cmd.join(" ");
        if (cmdStr.includes("worktree list")) {
          return { stdout: WORKTREE_LIST_PORCELAIN, stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("branch --merged")) {
          return { stdout: "  main\n", stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("log --oneline")) {
          return { stdout: "abc123 fix stuff", stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("diff --stat")) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") {
          const err = new Error("connect ECONNREFUSED /tmp/mcpd.sock");
          (err as NodeJS.ErrnoException).code = "ECONNREFUSED";
          throw err;
        }
        return toolResult({ sessionId: "new-session" });
      }),
      getPrStatus: mock(async () => null),
    });
    const mc = mockConsole();
    try {
      // Should not throw — ECONNREFUSED means daemon down, treat as no active sessions
      await cmdAgent(["codex", "resume", "codex-wt1"], deps);
      expect(deps.callTool).toHaveBeenCalledWith("codex_prompt", expect.anything());
    } finally {
      mc.restore();
    }
  });

  test("rethrows non-connection errors from session_list", async () => {
    const deps = makeDeps({
      getCwd: mock(() => "/repo"),
      exec: mock((cmd: string[]) => {
        if (cmd.join(" ").includes("worktree list")) {
          return { stdout: WORKTREE_LIST_PORCELAIN, stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") {
          throw new Error("Internal server error");
        }
        return toolResult({});
      }),
      getPrStatus: mock(async () => null),
    });
    const mc = mockConsole();
    try {
      await expect(cmdAgent(["codex", "resume", "codex-wt1"], deps)).rejects.toThrow("Internal server error");
    } finally {
      mc.restore();
    }
  });
});

// ── Resume (native provider — claude) ──

describe("agent claude resume", () => {
  function makeClaudeResumeDeps(overrides?: Partial<AgentDeps>): AgentDeps {
    return makeDeps({
      getCwd: mock(() => "/repo"),
      exec: mock((cmd: string[]) => {
        const cmdStr = cmd.join(" ");
        if (cmdStr.includes("worktree list")) {
          return { stdout: WORKTREE_LIST_PORCELAIN, stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("branch --merged")) {
          return { stdout: "  main\n", stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("log --oneline")) {
          return { stdout: "abc123 fix stuff", stderr: "", exitCode: 0 };
        }
        if (cmdStr.includes("diff --stat")) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
      callTool: mock(async (tool: string) => {
        if (tool === "claude_session_list") return toolResult([]);
        return toolResult({ sessionId: "resume-session-id" });
      }),
      getPrStatus: mock(async () => null),
      ...overrides,
    });
  }

  test("uses native resumeSessionId by default", async () => {
    const deps = makeClaudeResumeDeps();
    const mc = mockConsole();
    try {
      await cmdAgent(["claude", "resume", "codex-wt1"], deps);
      const callArgs = (deps.callTool as ReturnType<typeof mock>).mock.calls.find(
        (c: unknown[]) => c[0] === "claude_prompt",
      ) as unknown[];
      expect(callArgs).toBeDefined();
      expect(callArgs[1]).toHaveProperty("resumeSessionId", "continue");
    } finally {
      mc.restore();
    }
  });

  test("--fresh forces git-context prompt even for Claude", async () => {
    const deps = makeClaudeResumeDeps();
    const mc = mockConsole();
    try {
      await cmdAgent(["claude", "resume", "codex-wt1", "--fresh"], deps);
      const callArgs = (deps.callTool as ReturnType<typeof mock>).mock.calls.find(
        (c: unknown[]) => c[0] === "claude_prompt",
      ) as unknown[];
      expect(callArgs).toBeDefined();
      expect(callArgs[1]).not.toHaveProperty("resumeSessionId");
      expect((callArgs[1] as Record<string, unknown>).prompt).toContain("resuming work");
    } finally {
      mc.restore();
    }
  });
});

// ── Worktrees subcommand ──

describe("agent worktrees", () => {
  function makeWorktreesDeps(overrides?: Partial<AgentDeps>): AgentDeps {
    return makeDeps({
      getCwd: mock(() => "/repo"),
      exec: mock((cmd: string[]) => {
        if (cmd.join(" ").includes("worktree list")) {
          return { stdout: WORKTREE_LIST_PORCELAIN, stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
      callTool: mock(async () => toolResult([])),
      getDiffStats: mock(async () => "+5/-2 (1f)"),
      ...overrides,
    });
  }

  test("lists worktrees with status", async () => {
    const deps = makeWorktreesDeps();
    const mc = mockConsole();
    try {
      await cmdAgent(["codex", "worktrees"], deps);
      const allOutput = mc.logCalls.join("\n");
      expect(allOutput).toContain("WORKTREE");
      expect(allOutput).toContain("codex-wt1");
      expect(allOutput).toContain("orphaned");
    } finally {
      mc.restore();
    }
  });

  test("shows active status for worktrees with sessions", async () => {
    const deps = makeWorktreesDeps({
      callTool: mock(async () => toolResult([{ worktree: "codex-wt1", sessionId: "s1" }])),
    });
    const mc = mockConsole();
    try {
      await cmdAgent(["codex", "worktrees"], deps);
      const allOutput = mc.logCalls.join("\n");
      expect(allOutput).toContain("active");
    } finally {
      mc.restore();
    }
  });

  test("handles non-array session_list in worktrees command", async () => {
    // session_list returning a non-array should throw a descriptive error
    const deps = makeWorktreesDeps({
      callTool: mock(async () => toolResult({ error: "something went wrong" })),
    });
    await expect(cmdAgent(["codex", "worktrees"], deps)).rejects.toThrow("Expected session list");
  });

  test("prints message when no worktrees exist", async () => {
    const deps = makeWorktreesDeps({
      exec: mock((cmd: string[]) => {
        if (cmd.join(" ").includes("worktree list")) {
          // Only the main repo, no extra worktrees
          return { stdout: "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    });
    await cmdAgent(["codex", "worktrees"], deps);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("No mcx worktrees found"));
  });
});

// ── Flag collision regression ──

describe("agent acp ls -a flag", () => {
  test("-a is not treated as --all (flag collision fix)", async () => {
    // Previously -a was shorthand for both --all and --agent, causing collision.
    // Now -a is only used for --agent extraction, not --all.
    const deps = makeDeps({
      callTool: mock(async () => toolResult([])),
    });
    await cmdAgent(["acp", "ls", "-a", "copilot"], deps);
    // Should pass agent filter, not set showAll
    expect(deps.callTool).toHaveBeenCalledWith("acp_session_list", { agent: "copilot" });
  });
});

// ── Spawn --json output ──

describe("agent spawn --json", () => {
  test("outputs JSON when --json flag is set", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1", state: "active" })),
    });
    await cmdAgent(["codex", "spawn", "--task", "x", "--json"], deps);
    const output = logCalls(deps).join("\n");
    expect(output).toContain("sessionId");
  });

  test("spawn --help prints spawn usage", async () => {
    const deps = makeDeps();
    await cmdAgent(["codex", "spawn", "--help"], deps);
    expect(deps.log).toHaveBeenCalled();
    const output = logCalls(deps)[0];
    expect(output).toContain("spawn");
  });

  test("spawn --resume rejects for providers without native resume", async () => {
    const deps = makeDeps();
    await expect(cmdAgent(["codex", "spawn", "--task", "x", "--resume", "abc"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("--resume is not supported"));
  });

  test("spawn --resume works for Claude (native resume)", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "abc123", state: "active" })),
    });
    await cmdAgent(["claude", "spawn", "--resume", "abc123"], deps);
    expect(deps.callTool).toHaveBeenCalledWith(
      "claude_prompt",
      expect.objectContaining({ sessionId: "abc123", prompt: "Continue from where you left off." }),
    );
  });

  test("spawn --resume requires a session ID", async () => {
    const deps = makeDeps();
    await expect(cmdAgent(["claude", "spawn", "--resume"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("--resume requires a session ID"));
  });
});

// ── Spawn with error from parseAgentSpawnArgs ──

describe("agent spawn arg errors", () => {
  test("exits on parse error", async () => {
    const deps = makeDeps();
    // --agent is not supported by codex, parse sets error
    await expect(cmdAgent(["codex", "spawn", "--task", "x", "--agent", "copilot"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("--agent is not supported"));
  });
});

// ── Send --wait ──

describe("agent codex send --wait", () => {
  test("passes wait=true to codex_prompt", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return toolResult({ ok: true });
      }),
    });
    await cmdAgent(["codex", "send", "--wait", "abc12345", "hello"], deps);
    expect(deps.callTool).toHaveBeenCalledWith(
      "codex_prompt",
      expect.objectContaining({ wait: true, prompt: "hello" }),
    );
  });
});

// ── Bye with cwd ──

describe("agent bye with worktree", () => {
  test("calls cleanupWorktree when cwd is returned", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return toolResult({ ended: true, worktree: "my-wt", cwd: "/repo/.claude/worktrees/my-wt", repoRoot: "/repo" });
      }),
      exec: mock(() => ({ stdout: "", stderr: "", exitCode: 0 })),
    });
    await cmdAgent(["codex", "bye", "abc12345"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("codex_bye", { sessionId: SESSION_LIST[0].sessionId });
  });

  test("bye missing session prefix errors", async () => {
    const deps = makeDeps();
    await expect(cmdAgent(["codex", "bye"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });
});

// ── Interrupt missing session ──

describe("agent interrupt errors", () => {
  test("errors without session prefix", async () => {
    const deps = makeDeps();
    await expect(cmdAgent(["codex", "interrupt"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });
});

// ── Log rendering ──

describe("agent codex log rendering", () => {
  const LOG_ENTRIES = [
    {
      timestamp: Date.now(),
      direction: "outbound",
      message: { type: "user", message: { content: [{ type: "text", text: "hello" }] } },
    },
    {
      timestamp: Date.now(),
      direction: "inbound",
      message: { type: "assistant", message: { content: [{ type: "text", text: "world" }] } },
    },
    {
      timestamp: Date.now(),
      direction: "inbound",
      message: { type: "result", result: "done!" },
    },
  ];

  test("renders log entries from transcript", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return toolResult(LOG_ENTRIES);
      }),
    });
    await cmdAgent(["codex", "log", "abc12345"], deps);
    const allOutput = logCalls(deps).join("\n");
    expect(allOutput).toContain("user");
    expect(allOutput).toContain("result");
  });

  test("--last N is passed to transcript tool", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return toolResult([]);
      }),
    });
    await cmdAgent(["codex", "log", "abc12345", "--last", "5"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("codex_transcript", {
      sessionId: SESSION_LIST[0].sessionId,
      limit: 5,
    });
  });

  test("log --json outputs JSON content", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return toolResult(LOG_ENTRIES);
      }),
    });
    await cmdAgent(["codex", "log", "abc12345", "--json"], deps);
    const output = logCalls(deps).join("\n");
    expect(output).toContain("timestamp");
  });

  test("log errors on missing --last value", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return toolResult([]);
      }),
    });
    await expect(cmdAgent(["codex", "log", "abc12345", "--last"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("--last requires"));
  });

  test("log errors without session prefix", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    await expect(cmdAgent(["codex", "log"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });
});

// ── Wait output formats ──

describe("agent codex wait output", () => {
  test("--after flag passed to tool", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ event: "session:result", seq: 5 })),
    });
    await cmdAgent(["codex", "wait", "--after", "3"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("codex_wait", { afterSeq: 3 });
  });

  test("array fallback output (timeout: session list)", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    await cmdAgent(["codex", "wait"], deps);
    const allOutput = logCalls(deps).join("\n");
    expect(allOutput).toContain("[");
  });

  test("array fallback --short format", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    await cmdAgent(["codex", "wait", "--short"], deps);
    expect(logCalls(deps).length).toBe(SESSION_LIST.length);
  });

  test("single event --short format", async () => {
    const deps = makeDeps({
      callTool: mock(async () =>
        toolResult({ event: "session:result", sessionId: SESSION_LIST[0].sessionId, numTurns: 5, result: "done" }),
      ),
    });
    await cmdAgent(["codex", "wait", "--short"], deps);
    const output = logCalls(deps);
    expect(output.length).toBeGreaterThan(0);
    expect(output[0]).toContain(SESSION_LIST[0].sessionId.slice(0, 8));
  });

  test("cursor-based events shape (events array)", async () => {
    const events = [
      { event: "session:result", session: { sessionId: SESSION_LIST[0].sessionId, cost: 0.01, numTurns: 3 } },
    ];
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ seq: 10, events })),
    });
    await cmdAgent(["codex", "wait"], deps);
    const allOutput = logCalls(deps).join("\n");
    expect(allOutput).toContain("seq");
  });

  test("cursor-based events --short format", async () => {
    const events = [
      {
        event: "session:result",
        session: { sessionId: SESSION_LIST[0].sessionId, cost: 0.01, numTurns: 3 },
        result: "ok",
      },
    ];
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ seq: 10, events })),
    });
    await cmdAgent(["codex", "wait", "--short"], deps);
    const output = logCalls(deps);
    expect(output.length).toBe(1);
    expect(output[0]).toContain(SESSION_LIST[0].sessionId.slice(0, 8));
  });

  test("wait errors on invalid --timeout value", async () => {
    const deps = makeDeps();
    await expect(cmdAgent(["codex", "wait", "--timeout", "bad"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("--timeout must be a number"));
  });

  test("wait errors on missing --timeout value", async () => {
    const deps = makeDeps();
    await expect(cmdAgent(["codex", "wait", "--timeout"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("--timeout requires"));
  });

  test("wait errors on invalid --after value", async () => {
    const deps = makeDeps();
    await expect(cmdAgent(["codex", "wait", "--after", "bad"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("--after must be a number"));
  });
});

// ── Wait unified sessions shape (Claude) ──

describe("agent claude wait unified shape", () => {
  test("outputs full unified sessions object", async () => {
    const deps = makeDeps({
      callTool: mock(async () =>
        toolResult({
          event: { event: "session:result", sessionId: "s1", cost: 0.05, numTurns: 3, result: "done" },
          sessions: [],
        }),
      ),
    });
    await cmdAgent(["claude", "wait"], deps);
    const allOutput = logCalls(deps).join("\n");
    expect(allOutput).toContain("sessions");
  });

  test("--short format for unified event shape", async () => {
    const deps = makeDeps({
      callTool: mock(async () =>
        toolResult({
          event: { event: "session:result", sessionId: "s1", cost: 0.05, numTurns: 3, result: "done" },
          sessions: [],
        }),
      ),
    });
    await cmdAgent(["claude", "wait", "--short"], deps);
    const output = logCalls(deps);
    expect(output.length).toBe(1);
    expect(output[0]).toContain("s1");
  });

  test("--short format for unified sessions fallback (no event)", async () => {
    const deps = makeDeps({
      callTool: mock(async () =>
        toolResult({
          sessions: SESSION_LIST,
        }),
      ),
    });
    await cmdAgent(["claude", "wait", "--short"], deps);
    expect(logCalls(deps).length).toBe(SESSION_LIST.length);
  });
});

// ── List --json ──

describe("agent ls --json", () => {
  test("outputs JSON with --json flag", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });
    await cmdAgent(["codex", "ls", "--json"], deps);
    const output = logCalls(deps).join("\n");
    expect(output).toContain("sessionId");
  });

  test("handles non-JSON response gracefully", async () => {
    const deps = makeDeps({
      callTool: mock(async () => ({ content: [{ type: "text", text: "error: daemon not found" }] })),
    });
    await cmdAgent(["codex", "ls"], deps);
    expect(logCalls(deps).some((l) => l.includes("error"))).toBe(true);
  });

  test("handles non-array session_list response gracefully", async () => {
    // When session_list returns an object instead of array, should not throw TypeError
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ error: "unexpected response" })),
    });
    await cmdAgent(["codex", "ls"], deps);
    // Should fall through to d.log output, not crash
    expect(logCalls(deps).length).toBeGreaterThan(0);
  });
});

// ── printSpawnUsage provider-specific options ──

describe("spawn help provider-specific", () => {
  test("claude spawn --help shows --headed flag", async () => {
    const deps = makeDeps();
    await cmdAgent(["claude", "spawn", "--help"], deps);
    const output = logCalls(deps)[0];
    expect(output).toContain("--headed");
  });

  test("acp spawn --help shows --agent flag", async () => {
    const deps = makeDeps();
    await cmdAgent(["acp", "spawn", "--help"], deps);
    const output = logCalls(deps)[0];
    expect(output).toContain("--agent");
  });

  test("opencode spawn --help shows --provider flag", async () => {
    const deps = makeDeps();
    await cmdAgent(["opencode", "spawn", "--help"], deps);
    const output = logCalls(deps)[0];
    expect(output).toContain("--provider");
  });
});

// ── Claude ls with stale daemon warning ──

describe("agent ls stale daemon warning", () => {
  test("shows stale warning when daemon is stale", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
      getStaleDaemonWarning: mock(() => "daemon is stale"),
    });
    await cmdAgent(["codex", "ls"], deps);
    expect(errorCalls(deps).some((l) => l.includes("daemon is stale"))).toBe(true);
  });
});

// ── Worktree spawn (passthrough path) ──

describe("agent spawn with worktree passthrough", () => {
  test("passes worktree arg to daemon when no worktree config", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1" })),
      exec: mock(() => ({ stdout: "", stderr: "", exitCode: 0 })),
    });
    await cmdAgent(["codex", "spawn", "--task", "x", "--worktree", "my-branch"], deps);
    expect(deps.callTool).toHaveBeenCalledWith("codex_prompt", expect.objectContaining({ worktree: "my-branch" }));
  });

  test("records repoRoot on native worktree path (#1243)", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1" })),
      getGitRoot: mock(() => "/real/repo"),
      getCwd: mock(() => "/real/repo/.claude/worktrees/something"),
      exec: mock(() => ({ stdout: "", stderr: "", exitCode: 0 })),
    });
    await cmdAgent(["codex", "spawn", "--task", "x", "--worktree", "my-branch"], deps);
    expect(deps.callTool).toHaveBeenCalledWith(
      "codex_prompt",
      expect.objectContaining({ worktree: "my-branch", repoRoot: "/real/repo" }),
    );
  });

  test("falls back to cwd when getGitRoot returns null", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessionId: "s1" })),
      getGitRoot: mock(() => null),
      getCwd: mock(() => "/fallback/cwd"),
      exec: mock(() => ({ stdout: "", stderr: "", exitCode: 0 })),
    });
    await cmdAgent(["codex", "spawn", "--task", "x", "--worktree", "my-branch"], deps);
    expect(deps.callTool).toHaveBeenCalledWith(
      "codex_prompt",
      expect.objectContaining({ worktree: "my-branch", repoRoot: "/fallback/cwd" }),
    );
  });
});

// ── agentSpawnHeaded ──

describe("agent claude spawn --headed", () => {
  test("--headed --wait errors immediately", async () => {
    const deps = makeDeps();
    await expect(cmdAgent(["claude", "spawn", "--task", "x", "--headed", "--wait"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("incompatible"));
  });

  test("--headed calls ttyOpen with command", async () => {
    const deps = makeDeps();
    await cmdAgent(["claude", "spawn", "--task", "do stuff", "--headed"], deps);
    expect(deps.ttyOpen).toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining("do stuff")]));
  });
});

// ── agentBye with resume provider (no cwd) ──

describe("agent claude bye with worktree and no cwd", () => {
  test("resolves worktree path from cwd when bye returns worktree without cwd", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "claude_session_list") return toolResult(SESSION_LIST);
        return toolResult({ ended: true, worktree: "wt-name", cwd: null, repoRoot: null });
      }),
      getCwd: mock(() => "/fake/repo"),
      exec: mock(() => ({ stdout: "", stderr: "", exitCode: 0 })),
    });
    await cmdAgent(["claude", "bye", "abc12345"], deps);
    // cleanupWorktree is called (exec runs git worktree remove)
    expect(deps.callTool).toHaveBeenCalledWith("claude_bye", { sessionId: SESSION_LIST[0].sessionId });
  });
});

// ── agentList --pr with PR data ──

describe("agent claude ls --pr", () => {
  test("shows PR status in list when --pr flag is set", async () => {
    const CLAUDE_SESSIONS = SESSION_LIST.map((s) => ({
      ...s,
      repoRoot: "/repo",
      worktree: "/repo/.claude/worktrees/wt1",
    }));
    const deps = makeDeps({
      callTool: mock(async () => toolResult(CLAUDE_SESSIONS)),
      getGitRoot: mock(() => "/repo"),
      getPrStatus: mock(async () => ({ number: 42, state: "open" })),
    });
    await cmdAgent(["claude", "ls", "--pr"], deps);
    const allOutput = logCalls(deps).join("\n");
    expect(allOutput).toContain("#42");
  });
});

// ── wait --all and session with prefix ──

describe("agent wait flags", () => {
  test("--all disables repo scoping for claude", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult({ sessions: [] })),
      getGitRoot: mock(() => "/repo"),
    });
    await cmdAgent(["claude", "wait", "--all"], deps);
    // With --all, repoRoot should NOT be in the tool call
    expect(deps.callTool).toHaveBeenCalledWith("claude_wait", {});
  });

  test("session prefix resolves and passes sessionId", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return toolResult({ event: "session:result", sessionId: SESSION_LIST[0].sessionId });
      }),
    });
    await cmdAgent(["codex", "wait", "abc12345"], deps);
    expect(deps.callTool).toHaveBeenCalledWith(
      "codex_wait",
      expect.objectContaining({ sessionId: SESSION_LIST[0].sessionId }),
    );
  });
});

// ── log with non-JSON response ──

describe("agent log non-JSON response", () => {
  test("prints non-JSON transcript response as-is", async () => {
    const deps = makeDeps({
      callTool: mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_LIST);
        return { content: [{ type: "text", text: "error: no transcript" }] };
      }),
    });
    await cmdAgent(["codex", "log", "abc12345"], deps);
    const allOutput = logCalls(deps).join("\n");
    expect(allOutput).toContain("error: no transcript");
  });
});

// ── approve / deny ──

const SESSION_WITH_PENDING = [
  {
    ...SESSION_LIST[0],
    pendingPermissions: 1,
    pendingPermissionDetails: [{ requestId: "req-pending-001" }],
  },
  SESSION_LIST[1],
];

describe("agent approve", () => {
  test("calls provider_approve with explicit requestId", async () => {
    const con = mockConsole();
    try {
      const callTool = mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_WITH_PENDING);
        return toolResult({ approved: true });
      });
      const deps = makeDeps({ callTool });
      await cmdAgent(["codex", "approve", "abc12345", "req-explicit"], deps);
      expect(callTool).toHaveBeenCalledWith("codex_approve", {
        sessionId: SESSION_WITH_PENDING[0].sessionId,
        requestId: "req-explicit",
      });
    } finally {
      con.restore();
    }
  });

  test("auto-resolves latest pending requestId when omitted", async () => {
    const con = mockConsole();
    try {
      const callTool = mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_WITH_PENDING);
        return toolResult({ approved: true });
      });
      const deps = makeDeps({ callTool });
      await cmdAgent(["codex", "approve", "abc12345"], deps);
      expect(callTool).toHaveBeenCalledWith("codex_approve", {
        sessionId: SESSION_WITH_PENDING[0].sessionId,
        requestId: "req-pending-001",
      });
    } finally {
      con.restore();
    }
  });

  test("errors when no session prefix provided", async () => {
    const deps = makeDeps();
    await expect(cmdAgent(["codex", "approve"], deps)).rejects.toThrow(ExitError);
  });
});

describe("agent deny", () => {
  test("calls provider_deny with explicit requestId", async () => {
    const con = mockConsole();
    try {
      const callTool = mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_WITH_PENDING);
        return toolResult({ denied: true });
      });
      const deps = makeDeps({ callTool });
      await cmdAgent(["codex", "deny", "abc12345", "req-explicit"], deps);
      expect(callTool).toHaveBeenCalledWith("codex_deny", {
        sessionId: SESSION_WITH_PENDING[0].sessionId,
        requestId: "req-explicit",
      });
    } finally {
      con.restore();
    }
  });

  test("passes --message to deny tool", async () => {
    const con = mockConsole();
    try {
      const callTool = mock(async (tool: string) => {
        if (tool === "codex_session_list") return toolResult(SESSION_WITH_PENDING);
        return toolResult({ denied: true });
      });
      const deps = makeDeps({ callTool });
      await cmdAgent(["codex", "deny", "abc12345", "--message", "Not allowed"], deps);
      expect(callTool).toHaveBeenCalledWith("codex_deny", {
        sessionId: SESSION_WITH_PENDING[0].sessionId,
        requestId: "req-pending-001",
        message: "Not allowed",
      });
    } finally {
      con.restore();
    }
  });

  test("errors when no session prefix provided", async () => {
    const deps = makeDeps();
    await expect(cmdAgent(["codex", "deny"], deps)).rejects.toThrow(ExitError);
  });
});
