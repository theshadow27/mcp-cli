import { type Mock, afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, isCommitted, readTransitionHistory } from "@mcp-cli/core";
import { WORKTREE_CONFIG_FILENAME } from "@mcp-cli/core/worktree-config";
import { _resetJqStateForTesting } from "../jq/index";
import { ExitError } from "../test-helpers";
import type { ClaudeDeps } from "./claude";
import {
  MODEL_SHORTNAMES,
  buildHeadedCommand,
  buildResumePrompt,
  cmdClaude,
  defaultGetPrStatus,
  extractIssueNumber,
  formatQuotaBanner,
  parseApproveArgs,
  parseDenyArgs,
  parseDiffShortstat,
  parseLogArgs,
  parseResumeArgs,
  parseSpawnArgs,
  parseWaitArgs,
  parseWorktreeList,
  resolveModelName,
  resolveSessionId,
  resolveWorktree,
} from "./claude";
import { colorState, extractContentSummary, formatSessionShort } from "./session-display";

// ── Helpers ──

function makeDeps(overrides?: Partial<ClaudeDeps>): ClaudeDeps {
  return {
    callTool: mock(async () => ({ content: [{ type: "text", text: "[]" }] })),
    log: mock(() => {}),
    printError: mock(() => {}),
    printInfo: mock(() => {}),
    exit: mock((code: number) => {
      throw new ExitError(code);
    }) as ClaudeDeps["exit"],
    getDiffStats: mock(async () => null),
    getPrStatus: mock(async () => null),
    exec: mock(() => ({ stdout: "", stderr: "", exitCode: 0 })),
    ttyOpen: mock(async () => {}),
    getGitRoot: mock(() => null),
    getStaleDaemonWarning: mock(() => null),
    pollMail: mock(async () => null),
    runPatchUpdate: mock(async () => ({
      status: "noop" as const,
      version: "2.1.119",
      strategyId: "noop-pre-2.1.120",
      sourcePath: "/usr/local/bin/claude",
      sourceHash: "abc123",
      reason: "no patch needed",
    })),
    ...overrides,
  };
}

function logCalls(deps: ClaudeDeps): string[] {
  return (deps.log as Mock<(...a: unknown[]) => void>).mock.calls.map((c) => String(c[0]));
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

  test("parses --headed flag", () => {
    const result = parseSpawnArgs(["--headed", "--task", "fix bug"]);
    expect(result.headed).toBe(true);
    expect(result.task).toBe("fix bug");
  });

  test("headed defaults to false", () => {
    const result = parseSpawnArgs(["--task", "fix bug"]);
    expect(result.headed).toBe(false);
  });

  test("parses --name flag", () => {
    const result = parseSpawnArgs(["--name", "Alice", "--task", "fix bug"]);
    expect(result.name).toBe("Alice");
  });

  test("parses -n shorthand", () => {
    const result = parseSpawnArgs(["-n", "Bob", "-t", "fix bug"]);
    expect(result.name).toBe("Bob");
  });

  test("name defaults to undefined", () => {
    const result = parseSpawnArgs(["--task", "fix bug"]);
    expect(result.name).toBeUndefined();
  });

  test("errors on missing --name value", () => {
    const result = parseSpawnArgs(["--name"]);
    expect(result.error).toBe("--name requires a value");
  });

  test("parses --work-item flag", () => {
    const result = parseSpawnArgs(["--work-item", "#1570", "--task", "x"]);
    expect(result.workItemId).toBe("#1570");
    expect(result.error).toBeUndefined();
  });

  test("parses --work-item= equals form", () => {
    const result = parseSpawnArgs(["--work-item=#1570", "--task", "x"]);
    expect(result.workItemId).toBe("#1570");
  });

  test("errors on missing --work-item value", () => {
    const result = parseSpawnArgs(["--work-item"]);
    expect(result.error).toBe("--work-item requires an id");
  });

  test("workItemId defaults to undefined", () => {
    const result = parseSpawnArgs(["--task", "x"]);
    expect(result.workItemId).toBeUndefined();
  });

  test("errors and does not consume next flag when --work-item value looks like a flag", () => {
    const result = parseSpawnArgs(["--work-item", "--task", "x"]);
    expect(result.error).toBe("--work-item requires an id");
    expect(result.workItemId).toBeUndefined();
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

  test("parses --tail flag (alias for --last)", () => {
    const result = parseLogArgs(["abc123", "--tail", "50"]);
    expect(result.last).toBe(50);
    expect(result.sessionPrefix).toBe("abc123");
    expect(result.error).toBeUndefined();
  });

  test("--tail does not consume session id as its value", () => {
    const result = parseLogArgs(["--tail", "30", "abc123"]);
    expect(result.last).toBe(30);
    expect(result.sessionPrefix).toBe("abc123");
  });

  test("errors on non-numeric --last", () => {
    const result = parseLogArgs(["abc123", "--last", "abc"]);
    expect(result.error).toBe("--last must be a number");
  });

  test("errors on non-numeric --tail", () => {
    const result = parseLogArgs(["abc123", "--tail", "abc"]);
    expect(result.error).toBe("--tail must be a number");
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

  test("resolves by name (case-insensitive)", async () => {
    const sessions = [
      { sessionId: "abc12345-1111-2222-3333-444444444444", name: "Alice" },
      { sessionId: "def67890-aaaa-bbbb-cccc-dddddddddddd", name: "Bob" },
    ];
    const deps = makeDeps({
      callTool: mock(async () => toolResult(sessions)),
    });
    const id = await resolveSessionId("alice", deps);
    expect(id).toBe("abc12345-1111-2222-3333-444444444444");
  });

  test("name match takes priority over UUID prefix", async () => {
    const sessions = [
      { sessionId: "abc12345-1111-2222-3333-444444444444", name: "Alice" },
      { sessionId: "def67890-aaaa-bbbb-cccc-dddddddddddd", name: "Bob" },
    ];
    const deps = makeDeps({
      callTool: mock(async () => toolResult(sessions)),
    });
    const id = await resolveSessionId("Bob", deps);
    expect(id).toBe("def67890-aaaa-bbbb-cccc-dddddddddddd");
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

  test("routes through cmdAgent when no deps provided (production path)", async () => {
    // Without deps, cmdClaude should delegate to cmdAgent(["claude", ...args]).
    // Use "spawn --help" which prints usage without hitting IPC.
    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["spawn", "--help"]);
      const output = logSpy.mock.calls.map((c) => (c as string[])[0]).join("\n");
      // Spawn uses provider-specific help via agentSpawn, not the generic registry
      expect(output).toContain("mcx agent claude spawn");
    } finally {
      console.log = origLog;
    }
  });
});

// ── spawn ──

describe("mcx claude spawn", () => {
  test("--help prints usage and does not call tool", async () => {
    const callTool = mock(async () => toolResult({ success: true }));
    const deps = makeDeps({ callTool });
    await cmdClaude(["spawn", "--help"], deps);
    expect(callTool).not.toHaveBeenCalled();
    const output = logCalls(deps).join("\n");
    expect(output).toContain("mcx claude spawn");
    expect(output).toContain("--task");
    expect(output).toContain("--worktree");
    expect(output).toContain("--allow");
    expect(output).toContain("Examples:");
  });

  test("calls claude_prompt with task", async () => {
    const callTool = mock(async () => toolResult({ sessionId: "abc", success: true, cost: 0.01 }));
    const deps = makeDeps({ callTool });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["spawn", "--task", "fix the bug"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_prompt", { prompt: "fix the bug", cwd: process.cwd() });
    } finally {
      console.log = origLog;
    }
  });

  test("defaults cwd to caller's process.cwd() when not provided (#1331)", async () => {
    const callTool = mock(async () => toolResult({ success: true }));
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["spawn", "--task", "x"], deps);
      const toolCalls = callTool.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
      expect(toolCalls[0][1].cwd).toBe(process.cwd());
    } finally {
      console.log = origLog;
    }
  });

  test("explicit --cwd overrides default", async () => {
    const callTool = mock(async () => toolResult({ success: true }));
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["spawn", "--task", "x", "--cwd", "/tmp/elsewhere"], deps);
      const toolCalls = callTool.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
      expect(toolCalls[0][1].cwd).toBe("/tmp/elsewhere");
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
      const toolCalls = callTool.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
      expect(toolCalls[0][0]).toBe("claude_prompt");
      expect(toolCalls[0][1].prompt).toBe("x");
      expect(toolCalls[0][1].worktree).toBe("feat");
      expect(toolCalls[0][1].allowedTools).toEqual(["Read", "Glob"]);
      // Worktree is pre-created: cwd and repoRoot must be set (#1109)
      expect(toolCalls[0][1].cwd).toBeDefined();
      expect(toolCalls[0][1].repoRoot).toBeDefined();
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
        cwd: process.cwd(),
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
        cwd: process.cwd(),
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
      expect(callTool).toHaveBeenCalledWith("claude_prompt", { prompt: "fix", wait: true, cwd: process.cwd() });
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
        cwd: process.cwd(),
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

  test("refuses to spawn when daemon is stale (#1218)", async () => {
    const callTool = mock(async () => toolResult({ sessionId: "abc" }));
    const deps = makeDeps({
      callTool,
      getStaleDaemonWarning: mock(() => "Daemon is running a different build..."),
    });
    await expect(cmdClaude(["spawn", "--task", "fix"], deps)).rejects.toThrow(ExitError);
    expect(callTool).not.toHaveBeenCalled();
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("different build"));
  });

  test("writes null→initial transition when --work-item provided (#1623)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-transition-"));
    try {
      // Minimal manifest so loadManifest can find the initial phase
      writeFileSync(
        join(dir, ".mcx.yaml"),
        "version: 1\nrunsOn: main\ninitial: impl\nphases:\n  impl:\n    source: ./impl.ts\n    next: []\n",
      );

      const callTool = mock(async () => toolResult({ sessionId: "s1" }));
      const origLog = console.log;
      console.log = mock(() => {});
      try {
        await cmdClaude(
          ["spawn", "--task", "implement 1570", "--work-item", "#1570"],
          makeDeps({ callTool, getGitRoot: mock(() => dir) }),
        );
      } finally {
        console.log = origLog;
      }

      const logPath = join(dir, ".mcx", "transitions.jsonl");
      const committed = readTransitionHistory(logPath, "#1570").filter(isCommitted);
      expect(committed).toHaveLength(1);
      expect(committed[0].from).toBeNull();
      expect(committed[0].to).toBe("impl");
      expect(committed[0].workItemId).toBe("#1570");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("transition write is idempotent — second spawn does not corrupt log (#1623)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-transition-idem-"));
    try {
      writeFileSync(
        join(dir, ".mcx.yaml"),
        "version: 1\nrunsOn: main\ninitial: impl\nphases:\n  impl:\n    source: ./impl.ts\n    next: []\n",
      );
      mkdirSync(join(dir, ".mcx"), { recursive: true });

      const callTool = mock(async () => toolResult({ sessionId: "s2" }));
      const deps = makeDeps({ callTool, getGitRoot: mock(() => dir) });
      const origLog = console.log;
      console.log = mock(() => {});
      try {
        // First spawn
        await cmdClaude(["spawn", "--task", "x", "--work-item", "#1570"], deps);
        // Second spawn — must not throw or double-write a non-idempotent entry
        await cmdClaude(["spawn", "--task", "x", "--work-item", "#1570"], deps);
      } finally {
        console.log = origLog;
      }

      const logPath = join(dir, ".mcx", "transitions.jsonl");
      const committed = readTransitionHistory(logPath, "#1570").filter(isCommitted);
      // Two committed entries: null→impl then impl→impl (idempotent self-loop)
      expect(committed.length).toBeGreaterThanOrEqual(1);
      // The first entry is always null→impl
      expect(committed[0].from).toBeNull();
      expect(committed[0].to).toBe("impl");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("spawn succeeds even when no .mcx.yaml exists (#1623)", async () => {
    const callTool = mock(async () => toolResult({ sessionId: "s3" }));
    const deps = makeDeps({
      callTool,
      getGitRoot: mock(() => "/nonexistent/repo/root"),
    });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      // Should not throw — missing manifest is silently ignored
      await cmdClaude(["spawn", "--task", "x", "--work-item", "#1570"], deps);
      expect(callTool).toHaveBeenCalledTimes(1);
    } finally {
      console.log = origLog;
    }
  });
});

// ── buildHeadedCommand ──

describe("buildHeadedCommand", () => {
  test("builds basic command with task", () => {
    const result = buildHeadedCommand(parseSpawnArgs(["--task", "fix bug"]));
    expect(result).toBe("claude -p 'fix bug'");
  });

  test("includes model flag", () => {
    const result = buildHeadedCommand(parseSpawnArgs(["--task", "x", "--model", "sonnet"]));
    expect(result).toBe("claude -p x --model claude-sonnet-4-6");
  });

  test("includes allowedTools", () => {
    const result = buildHeadedCommand(parseSpawnArgs(["--task", "x", "--allow", "Read", "Glob"]));
    expect(result).toBe("claude -p x --allowedTools Read Glob");
  });

  test("handles task with special characters", () => {
    const result = buildHeadedCommand(parseSpawnArgs(["--task", "fix the 'bug' now"]));
    expect(result).toBe("claude -p 'fix the '\\''bug'\\'' now'");
  });

  test("no -p flag when no task", () => {
    const args = parseSpawnArgs(["--headed"]);
    const result = buildHeadedCommand(args);
    expect(result).toBe("claude");
  });
});

// ── headed spawn ──

describe("mcx claude spawn --headed", () => {
  test("calls ttyOpen with claude command", async () => {
    const ttyOpen = mock(async () => {});
    const deps = makeDeps({ ttyOpen });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["spawn", "--headed", "--task", "fix bug"], deps);
      expect(ttyOpen).toHaveBeenCalledTimes(1);
      const args = ttyOpen.mock.calls[0] as unknown as [string[]];
      expect(args[0][0]).toContain("claude -p 'fix bug'");
    } finally {
      console.log = origLog;
    }
  });

  test("does not call callTool (bypasses daemon)", async () => {
    const callTool = mock(async () => toolResult({}));
    const ttyOpen = mock(async () => {});
    const deps = makeDeps({ callTool, ttyOpen });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["spawn", "--headed", "--task", "fix"], deps);
      expect(callTool).not.toHaveBeenCalled();
    } finally {
      console.log = origLog;
    }
  });

  test("errors on --headed with --resume", async () => {
    const deps = makeDeps();
    await expect(cmdClaude(["spawn", "--headed", "--resume", "abc123", "--task", "x"], deps)).rejects.toThrow(
      ExitError,
    );
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("--headed and --resume are incompatible"));
  });

  test("errors on --headed with --wait", async () => {
    const deps = makeDeps();
    await expect(cmdClaude(["spawn", "--headed", "--wait", "--task", "x"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("--headed and --wait are incompatible"));
  });

  test("creates worktree and sets cwd for --headed --worktree", async () => {
    const ttyOpen = mock(async () => {});
    const exec = mock(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const deps = makeDeps({ ttyOpen, exec });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["spawn", "--headed", "--task", "x", "--worktree", "my-feat"], deps);
      // Verify git worktree add was called
      const execCalls = exec.mock.calls as unknown as Array<[string[]]>;
      const wtCall = execCalls.find((c) => c[0][0] === "git" && c[0][1] === "worktree");
      expect(wtCall).toBeDefined();
      expect(wtCall?.[0]).toContain("add");
      // Verify ttyOpen was called with cd to worktree path
      const ttyArgs = ttyOpen.mock.calls[0] as unknown as [string[]];
      expect(ttyArgs[0][0]).toContain("cd ");
      expect(ttyArgs[0][0]).toContain("my-feat");
    } finally {
      console.log = origLog;
    }
  });

  test("headed --worktree uses headed/ prefix by default", async () => {
    const ttyOpen = mock(async () => {});
    const exec = mock(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const deps = makeDeps({ ttyOpen, exec });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["spawn", "--headed", "--task", "x", "--worktree", "my-feat"], deps);
      const execCalls = exec.mock.calls as unknown as Array<[string[]]>;
      const wtCall = execCalls.find((c) => c[0][0] === "git" && c[0][1] === "worktree");
      expect(wtCall?.[0]).toContain("headed/my-feat");
    } finally {
      console.log = origLog;
    }
  });

  test("headed --worktree skips prefix when branchPrefix: false", async () => {
    const fakeRoot = mkdtempSync(join(tmpdir(), "mcx-claude-wt-"));
    try {
      writeFileSync(join(fakeRoot, WORKTREE_CONFIG_FILENAME), JSON.stringify({ worktree: { branchPrefix: false } }));
      const ttyOpen = mock(async () => {});
      const exec = mock(() => ({ stdout: "", stderr: "", exitCode: 0 }));
      const deps = makeDeps({ ttyOpen, exec, getGitRoot: mock(() => fakeRoot) });

      const origLog = console.log;
      console.log = mock(() => {});
      try {
        await cmdClaude(["spawn", "--headed", "--task", "x", "--worktree", "my-feat"], deps);
        const execCalls = exec.mock.calls as unknown as Array<[string[]]>;
        const wtCall = execCalls.find((c) => c[0][0] === "git" && c[0][1] === "worktree");
        // Branch name should be "my-feat" without prefix
        expect(wtCall?.[0]).toContain("my-feat");
        expect(wtCall?.[0]).not.toContain("headed/my-feat");
      } finally {
        console.log = origLog;
      }
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});

describe("mcx claude spawn --worktree branchPrefix", () => {
  test("headless --worktree pre-creates worktree without prefix when branchPrefix: false", async () => {
    const fakeRoot = mkdtempSync(join(tmpdir(), "mcx-claude-wt-"));
    try {
      writeFileSync(join(fakeRoot, WORKTREE_CONFIG_FILENAME), JSON.stringify({ worktree: { branchPrefix: false } }));
      const exec = mock(() => ({ stdout: "", stderr: "", exitCode: 0 }));
      const callTool = mock(async () => toolResult({ sessionId: "s1" }));
      const deps = makeDeps({ exec, callTool, getGitRoot: mock(() => fakeRoot) });

      const origLog = console.log;
      console.log = mock(() => {});
      try {
        await cmdClaude(["spawn", "--task", "x", "--worktree", "my-feat"], deps);
        // Verify git worktree add was called with raw branch name
        const execCalls = exec.mock.calls as unknown as Array<[string[]]>;
        const wtCall = execCalls.find((c) => c[0][0] === "git" && c[0][1] === "worktree");
        expect(wtCall).toBeDefined();
        expect(wtCall?.[0]).toContain("my-feat");
        // Verify cwd was set (pre-created worktree path passed as cwd)
        const toolCalls = callTool.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
        expect(toolCalls[0][1].cwd).toBeDefined();
        expect(toolCalls[0][1].worktree).toBe("my-feat");
      } finally {
        console.log = origLog;
      }
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  test("headless --worktree pre-creates worktree with claude/ prefix and passes cwd", async () => {
    const exec = mock(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const callTool = mock(async () => toolResult({ sessionId: "s1" }));
    const deps = makeDeps({ exec, callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["spawn", "--task", "x", "--worktree", "my-feat"], deps);
      // Worktree is pre-created via git worktree add (#1109)
      const execCalls = exec.mock.calls as unknown as Array<[string[]]>;
      const wtCall = execCalls.find((c) => c[0][0] === "git" && c[0][1] === "worktree");
      expect(wtCall).toBeDefined();
      // Branch name must use claude/ prefix to avoid collisions with main-repo branches (#1115)
      expect(wtCall?.[0]).toContain("claude/my-feat");
      // cwd must be set so daemon spawns Claude in the worktree, not the main repo
      const toolCalls = callTool.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
      expect(toolCalls[0][1].worktree).toBe("my-feat");
      expect(toolCalls[0][1].cwd).toBeDefined();
      expect(toolCalls[0][1].repoRoot).toBeDefined();
    } finally {
      console.log = origLog;
    }
  });

  test("--worktree uses getGitRoot for repoRoot (#1243)", async () => {
    const exec = mock(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const callTool = mock(async () => toolResult({ sessionId: "s1" }));
    const getGitRoot = mock(() => "/resolved/repo/root");
    const deps = makeDeps({ exec, callTool, getGitRoot });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["spawn", "--task", "x", "--worktree", "my-feat"], deps);
      const toolCalls = callTool.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
      expect(toolCalls[0][1].repoRoot).toBe("/resolved/repo/root");
    } finally {
      console.log = origLog;
    }
  });

  test("cleans up worktree when IPC callTool fails (#1116)", async () => {
    const exec = mock(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const callTool = mock(async () => {
      throw new Error("daemon unreachable");
    });
    const printError = mock(() => {});
    const deps = makeDeps({ exec, callTool, printError });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["spawn", "--task", "x", "--worktree", "my-feat"], deps);
      throw new Error("should have exited");
    } catch (e) {
      expect(e).toBeInstanceOf(ExitError);
      expect((e as ExitError).code).toBe(1);

      // Verify cleanup was attempted: git status --porcelain on the worktree path
      const execCalls = exec.mock.calls as unknown as Array<[string[], { env?: Record<string, string> }?]>;
      const statusCall = execCalls.find(
        (c) => c[0][0] === "git" && c[0][1] === "-C" && c[0].includes("status") && c[0].includes("--porcelain"),
      );
      expect(statusCall).toBeDefined();

      // Verify the error message was printed
      const errorCalls = printError.mock.calls as unknown as Array<[string]>;
      expect(errorCalls.some((c) => c[0].includes("daemon unreachable"))).toBe(true);
    } finally {
      console.log = origLog;
    }
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

  test("--short outputs compact one-line-per-session", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult(SESSION_LIST)),
    });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["ls", "--short"], deps);
      // No header row — just one line per session
      expect(logSpy.mock.calls.length).toBe(2);
      const line1 = (logSpy.mock.calls[0] as string[])[0];
      expect(line1).toContain("abc12345");
      expect(line1).toContain("active");
      expect(line1).toContain("opus-4");
      expect(line1).toContain("$0.0500");
      expect(line1).toContain("1000");
      expect(line1).toContain("3");
      const line2 = (logSpy.mock.calls[1] as string[])[0];
      expect(line2).toContain("def67890");
      expect(line2).toContain("idle");
    } finally {
      console.log = origLog;
    }
  });

  test("filters sessions by repo root when getGitRoot returns a path", async () => {
    // Daemon-side filtering: mock returns only matching session
    const filteredSessions = [{ ...SESSION_LIST[0], repoRoot: "/repo/a" }];
    const callTool = mock(async () => toolResult(filteredSessions));
    const deps = makeDeps({
      callTool,
      getGitRoot: mock(() => "/repo/a"),
    });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["ls"], deps);
      // Verify repoRoot is passed to daemon
      expect(callTool).toHaveBeenCalledWith("claude_session_list", { repoRoot: "/repo/a" });
      // Header + 1 matching session (not 2)
      expect(logSpy.mock.calls.length).toBe(2);
      const row = (logSpy.mock.calls[1] as string[])[0];
      expect(row).toContain("abc12345");
    } finally {
      console.log = origLog;
    }
  });

  test("--all bypasses repo root filtering", async () => {
    const sessions = [
      { ...SESSION_LIST[0], repoRoot: "/repo/a" },
      { ...SESSION_LIST[1], repoRoot: "/repo/b" },
    ];
    const callTool = mock(async () => toolResult(sessions));
    const deps = makeDeps({
      callTool,
      getGitRoot: mock(() => "/repo/a"),
    });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["ls", "--all"], deps);
      // No repoRoot passed — daemon returns all sessions
      expect(callTool).toHaveBeenCalledWith("claude_session_list", {});
      // Header + 2 sessions (no filtering)
      expect(logSpy.mock.calls.length).toBe(3);
    } finally {
      console.log = origLog;
    }
  });

  test("-a is an alias for --all", async () => {
    const sessions = [
      { ...SESSION_LIST[0], repoRoot: "/repo/a" },
      { ...SESSION_LIST[1], repoRoot: "/repo/b" },
    ];
    const callTool = mock(async () => toolResult(sessions));
    const deps = makeDeps({
      callTool,
      getGitRoot: mock(() => "/repo/a"),
    });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["ls", "-a"], deps);
      expect(logSpy.mock.calls.length).toBe(3);
    } finally {
      console.log = origLog;
    }
  });

  test("shows all sessions when not in a git repo", async () => {
    const sessions = [
      { ...SESSION_LIST[0], repoRoot: "/repo/a" },
      { ...SESSION_LIST[1], repoRoot: "/repo/b" },
    ];
    const deps = makeDeps({
      callTool: mock(async () => toolResult(sessions)),
      getGitRoot: mock(() => null),
    });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["ls"], deps);
      // Header + 2 sessions (no filtering when outside git repo)
      expect(logSpy.mock.calls.length).toBe(3);
    } finally {
      console.log = origLog;
    }
  });

  test("sessions with null repoRoot are visible when filtering by repo", async () => {
    const sessions = [
      { ...SESSION_LIST[0], repoRoot: "/repo/a" },
      { ...SESSION_LIST[1], repoRoot: null },
    ];
    const deps = makeDeps({
      callTool: mock(async () => toolResult(sessions)),
      getGitRoot: mock(() => "/repo/a"),
    });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["ls"], deps);
      // Header + 2 sessions — ls relies on daemon-side filtering and
      // renders whatever the daemon returns.
      expect(logSpy.mock.calls.length).toBe(3);
    } finally {
      console.log = origLog;
    }
  });

  test("emits generic message when no sessions exist and none filtered", async () => {
    const deps = makeDeps({
      callTool: mock(async () => toolResult([])),
      getGitRoot: mock(() => "/repo/a"),
    });

    const errSpy = mock(() => {});
    const origErr = console.error;
    const origLog = console.log;
    console.error = errSpy;
    console.log = mock(() => {});
    try {
      await cmdClaude(["ls"], deps);
      // Find the "No active sessions." call — other stderr output (e.g. daemon
      // startup noise from prior tests) may also land in errSpy.
      const noSessionsCall = errSpy.mock.calls.find(
        (args: unknown[]) => (args as string[])[0] === "No active sessions.",
      );
      expect(noSessionsCall).toBeDefined();
    } finally {
      console.error = origErr;
      console.log = origLog;
    }
  });
});

// ── formatSessionShort ──

describe("formatSessionShort", () => {
  test("formats session as compact one-liner", () => {
    const line = formatSessionShort({
      sessionId: "abc12345-1111-2222-3333-444444444444",
      state: "active",
      model: "opus-4",
      cost: 0.05,
      tokens: 1000,
      numTurns: 3,
    });
    expect(line).toBe("abc12345 active opus-4 $0.0500 1000 3");
  });

  test("uses dashes for missing values", () => {
    const line = formatSessionShort({
      sessionId: "abc12345-1111-2222-3333-444444444444",
      state: "idle",
      model: null,
      cost: 0,
      tokens: 0,
    });
    expect(line).toContain("abc12345 idle — — —");
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
  test("ends resolved session with message", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ ended: true });
    });
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def", "PR pushed and verified"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_bye", {
        sessionId: "def67890-aaaa-bbbb-cccc-dddddddddddd",
        message: "PR pushed and verified",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("warns when no closing message provided", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ ended: true });
    });
    const printError = mock(() => {});
    const deps = makeDeps({ callTool, printError });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_bye", {
        sessionId: "def67890-aaaa-bbbb-cccc-dddddddddddd",
      });
      const errOutput = printError.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(errOutput).toContain("no closing message");
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
      await cmdClaude(["quit", "abc", "done"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_bye", {
        sessionId: "abc12345-1111-2222-3333-444444444444",
        message: "done",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("errors when no session specified", async () => {
    const deps = makeDeps();
    await expect(cmdClaude(["bye"], deps)).rejects.toThrow(ExitError);
  });

  test("--keep skips worktree cleanup and prints preserved path", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ ended: true, worktree: "claude-abc123", cwd: "/repo" });
    });
    const exec: ClaudeDeps["exec"] = mock(() => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const printError = mock(() => {});
    const printInfo = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError, printInfo });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def", "--keep"], deps);
      // Should NOT call any git commands (no cleanup)
      expect(exec).not.toHaveBeenCalled();
      // Preserved message is informational, not an error
      const infoOutput = printInfo.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(infoOutput).toContain("Worktree preserved:");
      expect(infoOutput).toContain("/repo");
    } finally {
      console.log = origLog;
    }
  });

  test("--keep-worktree is an alias for --keep", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ ended: true, worktree: "claude-abc123", cwd: "/repo" });
    });
    const exec: ClaudeDeps["exec"] = mock(() => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const printError = mock(() => {});
    const printInfo = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError, printInfo });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def", "--keep-worktree"], deps);
      expect(exec).not.toHaveBeenCalled();
      const infoOutput = printInfo.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(infoOutput).toContain("Worktree preserved:");
    } finally {
      console.log = origLog;
    }
  });

  test("removes clean worktree after bye", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ ended: true, worktree: "claude-abc123", cwd: "/repo" });
    });
    const exec: ClaudeDeps["exec"] = mock((cmd: string[]) => {
      if (cmd.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError, printInfo });

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
      // Removal success is an info message, not an error
      const infoOutput = printInfo.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(infoOutput).toContain("Removed worktree:");
    } finally {
      console.log = origLog;
    }
  });

  test("resolves cwd from worktree name when daemon returns null cwd", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      // Daemon-created worktree: cwd and repoRoot are null
      return toolResult({ ended: true, worktree: "claude-abc123", cwd: null, repoRoot: null });
    });
    const exec: ClaudeDeps["exec"] = mock((cmd: string[]) => {
      if (cmd.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError, printInfo });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def"], deps);
      // Should still attempt cleanup by resolving cwd from process.cwd()
      const removeCalls = (exec as ReturnType<typeof mock>).mock.calls.filter((c: unknown[]) =>
        (c[0] as string[]).includes("remove"),
      );
      expect(removeCalls.length).toBe(1);
      // The worktree path should contain the worktree name
      expect(removeCalls[0][0].join(" ")).toContain("claude-abc123");
      const infoOutput = printInfo.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(infoOutput).toContain("Removed worktree:");
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
      if (cmd.includes("status")) return { stdout: " M file.ts\n?? new.ts", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
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
    const exec: ClaudeDeps["exec"] = mock(() => ({ stdout: "", stderr: "", exitCode: 0 }));
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
    const exec: ClaudeDeps["exec"] = mock(() => ({ stdout: "", stderr: "", exitCode: 128 }));
    const printError = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def", "worktree gone test"], deps);
      // Should call git status but not git worktree remove
      expect(exec).toHaveBeenCalledTimes(1);
      expect((exec as ReturnType<typeof mock>).mock.calls[0][0]).toContain("status");
      // No removal messages (only the bye warning if any)
      const errOutput = printError.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(errOutput).not.toContain("Removed worktree");
      expect(errOutput).not.toContain("uncommitted");
    } finally {
      console.log = origLog;
    }
  });

  test("reports success when directory is absent even if git remove fails", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ ended: true, worktree: "claude-locked", cwd: "/repo" });
    });
    const exec: ClaudeDeps["exec"] = mock((cmd: string[]) => {
      if (cmd.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("remove")) return { stdout: "", stderr: "", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError, printInfo });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def"], deps);
      // Directory doesn't exist on disk → verified removed regardless of exit code
      const infoOutput = printInfo.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(infoOutput).toContain("Removed worktree:");
    } finally {
      console.log = origLog;
    }
  });

  test("skips cleanup for path traversal attempt", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ ended: true, worktree: "../../..", cwd: "/repo" });
    });
    const exec: ClaudeDeps["exec"] = mock(() => ({ stdout: "", stderr: "", exitCode: 0 }));
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
    const exec: ClaudeDeps["exec"] = mock(() => ({ stdout: "", stderr: "", exitCode: 0 }));
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

  test("passes reason to tool when --reason flag is provided", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ interrupted: true });
    });
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["interrupt", "def", "--reason", "Wrong path, abandon it"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_interrupt", {
        sessionId: "def67890-aaaa-bbbb-cccc-dddddddddddd",
        reason: "Wrong path, abandon it",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("passes reason to tool when -r flag is provided", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ interrupted: true });
    });
    const deps = makeDeps({ callTool });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["interrupt", "def", "-r", "Stop editing"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_interrupt", {
        sessionId: "def67890-aaaa-bbbb-cccc-dddddddddddd",
        reason: "Stop editing",
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

  test("rejects --timeout > MAX_TIMEOUT_MS (cache TTL cap)", () => {
    const result = parseWaitArgs(["--timeout", String(MAX_TIMEOUT_MS + 1)]);
    expect(result.error).toContain("exceeds 4:59 cache-safe limit");
    expect(result.error).toContain(`${MAX_TIMEOUT_MS + 1}ms`);
  });

  test("accepts --timeout at cache-safe boundary (MAX_TIMEOUT_MS)", () => {
    const result = parseWaitArgs(["--timeout", String(MAX_TIMEOUT_MS)]);
    expect(result.error).toBeUndefined();
    expect(result.timeout).toBe(MAX_TIMEOUT_MS);
  });

  test("accepts recommended --timeout DEFAULT_TIMEOUT_MS", () => {
    const result = parseWaitArgs(["--timeout", String(DEFAULT_TIMEOUT_MS)]);
    expect(result.error).toBeUndefined();
    expect(result.timeout).toBe(DEFAULT_TIMEOUT_MS);
  });

  test("parses --after flag", () => {
    const result = parseWaitArgs(["--after", "42"]);
    expect(result.afterSeq).toBe(42);
    expect(result.error).toBeUndefined();
  });

  test("parses --after with session and timeout", () => {
    const result = parseWaitArgs(["abc123", "--after", "10", "--timeout", "5000"]);
    expect(result.sessionPrefix).toBe("abc123");
    expect(result.afterSeq).toBe(10);
    expect(result.timeout).toBe(5000);
  });

  test("errors on non-numeric --after", () => {
    const result = parseWaitArgs(["--after", "abc"]);
    expect(result.error).toBe("--after must be a number");
  });

  test("errors on missing --after value", () => {
    const result = parseWaitArgs(["--after"]);
    expect(result.error).toBe("--after requires a sequence number");
  });

  test("parses --short flag", () => {
    const result = parseWaitArgs(["--short"]);
    expect(result.short).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("parses --short with session and timeout", () => {
    const result = parseWaitArgs(["abc123", "--short", "--timeout", "5000"]);
    expect(result.sessionPrefix).toBe("abc123");
    expect(result.short).toBe(true);
    expect(result.timeout).toBe(5000);
  });

  test("parses --all flag", () => {
    const result = parseWaitArgs(["--all"]);
    expect(result.all).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("parses -a shorthand for --all", () => {
    const result = parseWaitArgs(["-a"]);
    expect(result.all).toBe(true);
  });

  test("defaults all to false", () => {
    const result = parseWaitArgs([]);
    expect(result.all).toBe(false);
  });

  test("parses --any flag", () => {
    const result = parseWaitArgs(["--any"]);
    expect(result.any).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("parses --pr flag with number", () => {
    const result = parseWaitArgs(["--pr", "1047"]);
    expect(result.pr).toBe(1047);
    expect(result.error).toBeUndefined();
  });

  test("errors on missing --pr value", () => {
    const result = parseWaitArgs(["--pr"]);
    expect(result.error).toBe("--pr requires a PR number");
  });

  test("errors on non-numeric --pr", () => {
    const result = parseWaitArgs(["--pr", "abc"]);
    expect(result.error).toBe("--pr must be a number");
  });

  test("parses --checks flag", () => {
    const result = parseWaitArgs(["--checks"]);
    expect(result.checks).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("parses --any --pr --checks combined", () => {
    const result = parseWaitArgs(["--any", "--pr", "42", "--checks", "--timeout", "30000"]);
    expect(result.any).toBe(true);
    expect(result.pr).toBe(42);
    expect(result.checks).toBe(true);
    expect(result.timeout).toBe(30000);
    expect(result.error).toBeUndefined();
  });

  test("defaults any/pr/checks to false/undefined/false", () => {
    const result = parseWaitArgs([]);
    expect(result.any).toBe(false);
    expect(result.pr).toBeUndefined();
    expect(result.checks).toBe(false);
  });

  test("parses --mail-to <name>", () => {
    const result = parseWaitArgs(["--mail-to", "orchestrator"]);
    expect(result.mailTo).toBe("orchestrator");
    expect(result.error).toBeUndefined();
  });

  test("parses --mail-to=<name>", () => {
    const result = parseWaitArgs(["--mail-to=orchestrator"]);
    expect(result.mailTo).toBe("orchestrator");
  });

  test("errors on missing --mail-to value", () => {
    const result = parseWaitArgs(["--mail-to"]);
    expect(result.error).toBe("--mail-to requires a recipient name");
  });
});

// ── claudeWait --mail-to behavioral tests ──

describe("claudeWait --mail-to", () => {
  test("wakes on incoming mail before session event", async () => {
    // Session wait blocks forever; mail arrives with future createdAt (passes HWM filter).
    const newMail = {
      id: 42,
      sender: "jacob",
      recipient: "orchestrator",
      subject: "main is red",
      body: "CI broken",
      replyTo: null,
      read: false,
      createdAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const deps = makeDeps({
      callTool: mock(() => new Promise(() => {})) as unknown as ClaudeDeps["callTool"],
      pollMail: mock(async (recipient: string) => (recipient === "orchestrator" ? newMail : null)),
    });
    const origLog = console.log;
    const logSpy = mock(() => {});
    console.log = logSpy;
    try {
      await cmdClaude(["wait", "--mail-to", "orchestrator", "--timeout", "5000"], deps);
    } finally {
      console.log = origLog;
    }
    const output = (logSpy.mock.calls as unknown[][]).map((c) => String(c[0])).join("\n");
    const parsed = JSON.parse(output);
    expect(parsed.source).toBe("mail");
    expect(parsed.mail.id).toBe(42);
    expect(deps.pollMail).toHaveBeenCalledWith("orchestrator");
  });

  test("does not wake on pre-existing unread mail (HWM filter)", async () => {
    // Mail created 1 minute ago predates the wait and must be ignored.
    const staleMail = {
      id: 1,
      sender: "jacob",
      recipient: "orchestrator",
      subject: "old message",
      body: null,
      replyTo: null,
      read: false,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const deps = makeDeps({
      callTool: mock(async () =>
        toolResult({
          event: { sessionId: "abc12345-1111-2222-3333-444444444444", event: "session:result" },
          sessions: [],
        }),
      ),
      pollMail: mock(async () => staleMail),
    });
    const origLog = console.log;
    const logSpy = mock(() => {});
    console.log = logSpy;
    try {
      await cmdClaude(["wait", "--mail-to", "orchestrator", "--timeout", "100"], deps);
    } finally {
      console.log = origLog;
    }
    const output = (logSpy.mock.calls as unknown[][]).map((c) => String(c[0])).join("\n");
    expect(output).not.toContain('"source": "mail"');
  });

  test("continues polling when pollMail throws transiently", async () => {
    // First call throws (IPC blip), second returns new mail. Wait must succeed.
    const newMail = {
      id: 77,
      sender: "qa",
      recipient: "orchestrator",
      subject: "tests passing",
      body: null,
      replyTo: null,
      read: false,
      createdAt: new Date(Date.now() + 60_000).toISOString(),
    };
    let calls = 0;
    const deps = makeDeps({
      callTool: mock(() => new Promise(() => {})) as unknown as ClaudeDeps["callTool"],
      pollMail: mock(async () => {
        if (calls++ === 0) throw new Error("ECONNREFUSED");
        return newMail;
      }),
    });
    const origLog = console.log;
    const logSpy = mock(() => {});
    console.log = logSpy;
    try {
      await cmdClaude(["wait", "--mail-to", "orchestrator", "--timeout", "5000"], deps);
    } finally {
      console.log = origLog;
    }
    const output = (logSpy.mock.calls as unknown[][]).map((c) => String(c[0])).join("\n");
    const parsed = JSON.parse(output);
    expect(parsed.source).toBe("mail");
    expect(parsed.mail.id).toBe(77);
  });
});

// ── wait ──

describe("mcx claude wait", () => {
  test("--help prints usage and does not call tool", async () => {
    const callTool = mock(async () => toolResult({ success: true }));
    const deps = makeDeps({ callTool });
    await cmdClaude(["wait", "--help"], deps);
    expect(callTool).not.toHaveBeenCalled();
    const output = logCalls(deps).join("\n");
    expect(output).toContain("mcx claude wait");
    expect(output).toContain("--timeout");
    expect(output).toContain("--all");
  });

  test("calls claude_wait with no args (any session)", async () => {
    const callTool = mock(async () =>
      toolResult({
        event: { sessionId: "abc123", event: "session:result", cost: 0.05 },
        sessions: SESSION_LIST,
      }),
    );
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
      return toolResult({
        event: { sessionId: "abc12345-1111-2222-3333-444444444444", event: "session:result" },
        sessions: SESSION_LIST,
      });
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
    const callTool = mock(async () =>
      toolResult({ event: { sessionId: "abc", event: "session:result" }, sessions: SESSION_LIST }),
    );
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

  test("prints unified shape on timeout fallback", async () => {
    // When the daemon times out, the result is { sessions: [...] } with no event
    const callTool = mock(async () => toolResult({ sessions: SESSION_LIST }));
    const deps = makeDeps({ callTool });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["wait", "--timeout", "1000"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_wait", { timeout: 1000 });
      // Output should contain the unified JSON with sessions
      const output = (logSpy.mock.calls[0] as string[])[0];
      const parsed = JSON.parse(output);
      expect(parsed.sessions).toHaveLength(2);
      expect(parsed.sessions[0].sessionId).toBe(SESSION_LIST[0].sessionId);
      expect(parsed.event).toBeUndefined();
    } finally {
      console.log = origLog;
    }
  });

  test("prints unified shape on event success", async () => {
    const eventData = { sessionId: "abc123", event: "session:result", cost: 0.05 };
    const callTool = mock(async () => toolResult({ event: eventData, sessions: SESSION_LIST }));
    const deps = makeDeps({ callTool });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["wait"], deps);
      const output = (logSpy.mock.calls[0] as string[])[0];
      const parsed = JSON.parse(output);
      expect(parsed.event.sessionId).toBe("abc123");
      expect(parsed.event.event).toBe("session:result");
      expect(parsed.sessions).toHaveLength(2);
    } finally {
      console.log = origLog;
    }
  });

  test("--short outputs compact event line", async () => {
    const callTool = mock(async () =>
      toolResult({
        event: {
          sessionId: "abc12345-1111-2222-3333-444444444444",
          event: "session:result",
          cost: 0.05,
          numTurns: 3,
          result: "Done fixing tests",
        },
        sessions: SESSION_LIST,
      }),
    );
    const deps = makeDeps({ callTool });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["wait", "--short"], deps);
      expect(logSpy.mock.calls.length).toBe(1);
      const line = (logSpy.mock.calls[0] as string[])[0];
      expect(line).toContain("abc12345");
      expect(line).toContain("session:result");
      expect(line).toContain("$0.0500");
      expect(line).toContain("3");
      expect(line).toContain("Done fixing tests");
    } finally {
      console.log = origLog;
    }
  });

  test("--short outputs compact session list on timeout fallback", async () => {
    const callTool = mock(async () => toolResult({ sessions: SESSION_LIST }));
    const deps = makeDeps({ callTool });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["wait", "--short", "--timeout", "1000"], deps);
      // One line per session, no header
      expect(logSpy.mock.calls.length).toBe(2);
      const line1 = (logSpy.mock.calls[0] as string[])[0];
      expect(line1).toContain("abc12345");
      expect(line1).toContain("active");
    } finally {
      console.log = origLog;
    }
  });

  test("--short filters timeout fallback by repo root", async () => {
    const sessions = [
      { ...SESSION_LIST[0], repoRoot: "/repo/a" },
      { ...SESSION_LIST[1], repoRoot: "/repo/b" },
    ];
    const callTool = mock(async () => toolResult({ sessions }));
    const deps = makeDeps({
      callTool,
      getGitRoot: mock(() => "/repo/a"),
    });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["wait", "--short", "--timeout", "1000"], deps);
      // Verify repoRoot is passed to daemon
      expect(callTool).toHaveBeenCalledWith("claude_wait", { timeout: 1000, repoRoot: "/repo/a" });
      // Only 1 session matches /repo/a
      expect(logSpy.mock.calls.length).toBe(1);
      const line = (logSpy.mock.calls[0] as string[])[0];
      expect(line).toContain("abc12345");
    } finally {
      console.log = origLog;
    }
  });

  test("--all bypasses repo filtering in wait", async () => {
    const sessions = [
      { ...SESSION_LIST[0], repoRoot: "/repo/a" },
      { ...SESSION_LIST[1], repoRoot: "/repo/b" },
    ];
    const callTool = mock(async () => toolResult({ sessions }));
    const deps = makeDeps({
      callTool,
      getGitRoot: mock(() => "/repo/a"),
    });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["wait", "--short", "--all", "--timeout", "1000"], deps);
      // No repoRoot passed — daemon returns all sessions
      expect(callTool).toHaveBeenCalledWith("claude_wait", { timeout: 1000 });
      // Both sessions shown
      expect(logSpy.mock.calls.length).toBe(2);
    } finally {
      console.log = origLog;
    }
  });

  test("filters cursor-based events by repo root in --short mode", async () => {
    // Daemon-side filtering: mock returns only matching event
    const waitResult = {
      seq: 5,
      events: [
        {
          event: "session:result",
          session: { sessionId: "abc12345", repoRoot: "/repo/a", cost: 0.05, numTurns: 2 },
        },
      ],
    };
    const callTool = mock(async () => toolResult(waitResult));
    const deps = makeDeps({
      callTool,
      getGitRoot: mock(() => "/repo/a"),
    });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["wait", "--short", "--after", "0"], deps);
      // Verify repoRoot is passed to daemon
      expect(callTool).toHaveBeenCalledWith("claude_wait", { afterSeq: 0, repoRoot: "/repo/a" });
      // Only event for /repo/a
      expect(logSpy.mock.calls.length).toBe(1);
      const line = (logSpy.mock.calls[0] as string[])[0];
      expect(line).toContain("abc12345");
    } finally {
      console.log = origLog;
    }
  });

  test("--short emits stderr note when timeout fallback filters all sessions", async () => {
    const sessions = [
      { ...SESSION_LIST[0], repoRoot: "/repo/b" },
      { ...SESSION_LIST[1], repoRoot: "/repo/b" },
    ];
    const callTool = mock(async () => toolResult({ sessions }));
    const deps = makeDeps({
      callTool,
      getGitRoot: mock(() => "/repo/a"),
    });

    const logSpy = mock(() => {});
    const errSpy = mock(() => {});
    const origLog = console.log;
    const origErr = console.error;
    console.log = logSpy;
    console.error = errSpy;
    try {
      await cmdClaude(["wait", "--short", "--timeout", "1000"], deps);
      // No sessions printed to stdout
      expect(logSpy.mock.calls.length).toBe(0);
      // Stderr note about hidden sessions
      expect(errSpy.mock.calls.length).toBe(1);
      expect((errSpy.mock.calls[0] as string[])[0]).toBe("(2 sessions in other repos — use --all to see them)");
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });

  test("--short emits stderr note when cursor-based events filter to empty", async () => {
    const waitResult = {
      seq: 5,
      events: [
        {
          event: "session:result",
          session: { sessionId: "abc12345", repoRoot: "/repo/b", cost: 0.05, numTurns: 2 },
        },
        {
          event: "session:result",
          session: { sessionId: "def67890", repoRoot: "/repo/b", cost: 0.02, numTurns: 1 },
        },
      ],
    };
    const callTool = mock(async () => toolResult(waitResult));
    const deps = makeDeps({
      callTool,
      getGitRoot: mock(() => "/repo/a"),
    });

    const logSpy = mock(() => {});
    const errSpy = mock(() => {});
    const origLog = console.log;
    const origErr = console.error;
    console.log = logSpy;
    console.error = errSpy;
    try {
      await cmdClaude(["wait", "--short", "--after", "0"], deps);
      expect(logSpy.mock.calls.length).toBe(0);
      expect(errSpy.mock.calls.length).toBe(1);
      expect((errSpy.mock.calls[0] as string[])[0]).toBe("(2 events in other repos — use --all to see them)");
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });

  // ── cross-repo event leak (#1308) ──

  test("drops single event whose session has foreign repoRoot (#1308)", async () => {
    // Daemon wakeup returns an event with a cross-repo session snapshot. The
    // client must drop the event rather than surfacing it on --short output.
    const leakedEvent = {
      source: "session",
      event: {
        sessionId: "ff008800-aaaa-bbbb-cccc-dddddddddddd",
        event: "session:result",
        session: { sessionId: "ff008800-aaaa-bbbb-cccc-dddddddddddd", repoRoot: "/repo/b", cwd: "/repo/b" },
      },
      sessions: [],
    };
    const callTool = mock(async () => toolResult(leakedEvent));
    const deps = makeDeps({ callTool, getGitRoot: mock(() => "/repo/a") });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["wait", "--short", "--timeout", "1000"], deps);
      for (const call of logSpy.mock.calls as string[][]) {
        expect(call[0]).not.toContain("ff008800");
      }
    } finally {
      console.log = origLog;
    }
  });

  test("drops event when session has null repoRoot but cwd is in another repo (#1308)", async () => {
    // Session missing repoRoot (core.bare ambient repo — #1243) must still be
    // filtered by cwd prefix so wait does not leak cross-repo wakeups.
    const leakedEvent = {
      source: "session",
      event: {
        sessionId: "ff008800-aaaa-bbbb-cccc-dddddddddddd",
        event: "session:result",
        session: { sessionId: "ff008800-aaaa-bbbb-cccc-dddddddddddd", repoRoot: null, cwd: "/repo/b/sub" },
      },
      sessions: [],
    };
    const callTool = mock(async () => toolResult(leakedEvent));
    const deps = makeDeps({ callTool, getGitRoot: mock(() => "/repo/a") });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["wait", "--short", "--timeout", "1000"], deps);
      for (const call of logSpy.mock.calls as string[][]) {
        expect(call[0]).not.toContain("ff008800");
      }
    } finally {
      console.log = origLog;
    }
  });

  test("keeps event when session matches repo via cwd fallback (#1308)", async () => {
    // Mirror of the drop case: null repoRoot + matching cwd must still surface.
    const inScopeEvent = {
      source: "session",
      event: {
        sessionId: "abc12345-1111-2222-3333-444444444444",
        event: "session:result",
        cost: 0.01,
        numTurns: 1,
        session: {
          sessionId: "abc12345-1111-2222-3333-444444444444",
          repoRoot: null,
          cwd: "/repo/a/worktree",
        },
      },
      sessions: [],
    };
    const callTool = mock(async () => toolResult(inScopeEvent));
    const deps = makeDeps({ callTool, getGitRoot: mock(() => "/repo/a") });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["wait", "--short", "--timeout", "1000"], deps);
      expect(logSpy.mock.calls.length).toBe(1);
      expect((logSpy.mock.calls[0] as string[])[0]).toContain("abc12345");
    } finally {
      console.log = origLog;
    }
  });

  test("passes through event when session has null repoRoot and null cwd under no filter (#1308)", async () => {
    // Ghost sessions (crashed workers, recorded before cwd was set) have both
    // repoRoot and cwd null. They must still surface when no --repo/--scope filter
    // is active, so the caller can observe and clean them up.
    const ghostEvent = {
      source: "session",
      event: {
        sessionId: "dead0000-cafe-babe-dead-000000000000",
        event: "session:result",
        session: { sessionId: "dead0000-cafe-babe-dead-000000000000", repoRoot: null, cwd: null },
      },
      sessions: [],
    };
    const callTool = mock(async () => toolResult(ghostEvent));
    // No getGitRoot override — defaults to null, meaning no repo filter is applied
    const deps = makeDeps({ callTool });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["wait", "--short", "--timeout", "1000"], deps);
      expect(logSpy.mock.calls.length).toBe(1);
      expect((logSpy.mock.calls[0] as string[])[0]).toContain("dead0000");
    } finally {
      console.log = origLog;
    }
  });

  // ── old daemon compat (pre-unification response shapes) ──

  test("--short handles bare event object from old daemon", async () => {
    // Old daemon returned bare event (no sessions wrapper) on event success
    const bareEvent = {
      sessionId: "abc12345-1111-2222-3333-444444444444",
      event: "session:result",
      cost: 0.05,
      numTurns: 3,
      result: "Done fixing tests",
    };
    const callTool = mock(async () => toolResult(bareEvent));
    const deps = makeDeps({ callTool });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["wait", "--short"], deps);
      expect(logSpy.mock.calls.length).toBe(1);
      const line = (logSpy.mock.calls[0] as string[])[0];
      expect(line).toContain("abc12345");
      expect(line).toContain("session:result");
      expect(line).toContain("$0.0500");
      expect(line).toContain("Done fixing tests");
    } finally {
      console.log = origLog;
    }
  });

  test("--short handles bare session array from old daemon timeout", async () => {
    // Old daemon returned bare array on timeout (no { sessions } wrapper)
    const callTool = mock(async () => toolResult(SESSION_LIST));
    const deps = makeDeps({ callTool });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["wait", "--short", "--timeout", "1000"], deps);
      expect(logSpy.mock.calls.length).toBe(2);
      const line1 = (logSpy.mock.calls[0] as string[])[0];
      expect(line1).toContain("abc12345");
      expect(line1).toContain("active");
    } finally {
      console.log = origLog;
    }
  });

  test("bare event from old daemon prints JSON without --short", async () => {
    const bareEvent = {
      sessionId: "abc12345",
      event: "session:result",
      cost: 0.05,
    };
    const callTool = mock(async () => toolResult(bareEvent));
    const deps = makeDeps({ callTool });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["wait"], deps);
      const output = (logSpy.mock.calls[0] as string[])[0];
      const parsed = JSON.parse(output);
      // Normalized to unified shape
      expect(parsed.event.sessionId).toBe("abc12345");
      expect(parsed.sessions).toEqual([]);
    } finally {
      console.log = origLog;
    }
  });

  test("bare session array from old daemon prints JSON without --short", async () => {
    const callTool = mock(async () => toolResult(SESSION_LIST));
    const deps = makeDeps({ callTool });

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdClaude(["wait", "--timeout", "1000"], deps);
      const output = (logSpy.mock.calls[0] as string[])[0];
      const parsed = JSON.parse(output);
      // Normalized to unified shape
      expect(parsed.sessions).toHaveLength(2);
      expect(parsed.event).toBeUndefined();
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
      expect(callTool).toHaveBeenCalledWith("claude_prompt", { prompt: "lifecycle test", cwd: process.cwd() });
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

      // 5. Bye — end the session (with closing message)
      logSpy.mockClear();
      await cmdClaude(["bye", "lifecycle", "test complete"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_bye", {
        sessionId: "lifecycle-1111-2222-3333-444444444444",
        message: "test complete",
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

// ── colorState ──

// In test env stdout.isTTY is false, so c.* colors are empty strings.
// We test the padding/trim behavior; color wrapping is verified by inspection.
describe("colorState", () => {
  test("pads state to 12 chars", () => {
    // In non-TTY test env colors are empty, result is just the padded string.
    const result = colorState("active");
    expect(result.trim()).toBe("active");
    expect(result.length).toBeGreaterThanOrEqual(12);
  });

  test("known states are padded to at least 12 chars", () => {
    for (const state of ["active", "connecting", "init", "waiting_permission", "disconnected", "ended"]) {
      expect(colorState(state).length).toBeGreaterThanOrEqual(12);
    }
  });

  test("unknown state returns padded string", () => {
    const result = colorState("unknown");
    expect(result.trim()).toBe("unknown");
    expect(result.length).toBeGreaterThanOrEqual(12);
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
      if (cmd.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("--show-current")) return { stdout: "feat/issue-42", stderr: "", exitCode: 0 };
      if (cmd.includes("remove")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("-d")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("rev-parse") && cmd.includes("--verify")) return { stdout: "", stderr: "", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError, printInfo });

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
      const infoOutput = printInfo.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(infoOutput).toContain("Deleted branch: feat/issue-42 (safe)");
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
      if (cmd.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("--show-current")) return { stdout: "feat/unmerged", stderr: "", exitCode: 0 };
      if (cmd.includes("remove")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("-d")) return { stdout: "", stderr: "", exitCode: 1 }; // unmerged
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError, printInfo });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["bye", "def"], deps);
      const infoOutput = printInfo.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(infoOutput).toContain("Removed worktree:");
      expect(infoOutput).not.toContain("Deleted branch:");
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
      if (cmd.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("--show-current")) return { stdout: "", stderr: "", exitCode: 0 }; // detached HEAD
      if (cmd.includes("remove")) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
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
          stderr: "",
          exitCode: 0,
        };
      }
      if (cmd.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
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

  test("prune removes clean orphaned worktrees with merged branches", async () => {
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
          stderr: "",
          exitCode: 0,
        };
      }
      if (cmd.includes("--merged")) return { stdout: "  main\n  feat/orphan\n", stderr: "", exitCode: 0 };
      if (cmd.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("remove")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("-d")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("rev-parse") && cmd.includes("--verify")) return { stdout: "", stderr: "", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError, printInfo });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["worktrees", "--prune"], deps);
      const errOutput = printError.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      const infoOutput = printInfo.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(infoOutput).toContain("Removed worktree:");
      expect(infoOutput).toContain("Deleted branch: feat/orphan (safe)");
      expect(infoOutput).toContain("Pruned 1 worktree.");
    } finally {
      console.log = origLog;
    }
  });

  test("prune skips worktrees with unmerged branches", async () => {
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
            `worktree ${cwd}/.claude/worktrees/claude-unmerged`,
            "HEAD 789abc",
            "branch refs/heads/feat/unmerged",
            "",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }
      // feat/unmerged is NOT in the merged list
      if (cmd.includes("--merged")) return { stdout: "  main\n", stderr: "", exitCode: 0 };
      if (cmd.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError, printInfo });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["worktrees", "--prune"], deps);
      const infoOutput = printInfo.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(infoOutput).toContain("Nothing to prune.");
      expect(infoOutput).toContain("Skipped 1 unmerged: feat/unmerged");
      // Should NOT call git worktree remove
      const removeCalls = (exec as ReturnType<typeof mock>).mock.calls.filter((c: unknown[]) =>
        (c[0] as string[]).includes("remove"),
      );
      expect(removeCalls.length).toBe(0);
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
      // Other provider session lists return empty (prune queries ALL providers)
      if (tool.endsWith("_session_list")) {
        return toolResult([]);
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
          stderr: "",
          exitCode: 0,
        };
      }
      if (cmd.includes("--merged")) return { stdout: "  main\n  feat/active\n", stderr: "", exitCode: 0 };
      if (cmd.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError, printInfo });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["worktrees", "--prune"], deps);
      const infoOutput = printInfo.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(infoOutput).toContain("Nothing to prune.");
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
          stderr: "",
          exitCode: 0,
        };
      }
      if (cmd.includes("--merged")) return { stdout: "  main\n  feat/dirty\n", stderr: "", exitCode: 0 };
      if (cmd.includes("status")) return { stdout: " M file.ts", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError, printInfo });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["worktrees", "--prune"], deps);
      const infoOutput = printInfo.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(infoOutput).toContain("Nothing to prune.");
    } finally {
      console.log = origLog;
    }
  });

  test("prune detects default branch from symbolic-ref", async () => {
    const callTool: ClaudeDeps["callTool"] = mock(async () => toolResult([]));
    const cwd = process.cwd();
    const exec: ClaudeDeps["exec"] = mock((cmd: string[]) => {
      if (cmd.includes("list") && cmd.includes("--porcelain")) {
        return {
          stdout: [
            `worktree ${cwd}`,
            "HEAD abc123",
            "branch refs/heads/master",
            "",
            `worktree ${cwd}/.claude/worktrees/claude-feature`,
            "HEAD 789abc",
            "branch refs/heads/feat/done",
            "",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }
      if (cmd.includes("symbolic-ref")) return { stdout: "refs/remotes/origin/master\n", stderr: "", exitCode: 0 };
      if (cmd.includes("--merged")) {
        // Only respond to "master" as the base — if "main" is passed, return empty
        if (cmd.includes("master")) return { stdout: "  master\n  feat/done\n", stderr: "", exitCode: 0 };
        return { stdout: "  main\n", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("remove")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("-d")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("rev-parse") && cmd.includes("--verify")) return { stdout: "", stderr: "", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError, printInfo });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["worktrees", "--prune"], deps);
      const errOutput = printError.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      const infoOutput = printInfo.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(infoOutput).toContain("Removed worktree:");
      expect(infoOutput).toContain("Deleted branch: feat/done (safe)");
      expect(infoOutput).toContain("Pruned 1 worktree.");
    } finally {
      console.log = origLog;
    }
  });

  test("prune falls back to pruning without merge check when git branch --merged fails", async () => {
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
          stderr: "",
          exitCode: 0,
        };
      }
      if (cmd.includes("--merged")) return { stdout: "", stderr: "", exitCode: 128 }; // git failure
      if (cmd.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("remove")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("-d")) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError, printInfo });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["worktrees", "--prune"], deps);
      const errOutput = printError.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      const infoOutput = printInfo.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(errOutput).toContain("Warning: could not determine merged branches");
      expect(infoOutput).toContain("Removed worktree:");
      expect(infoOutput).toContain("Pruned 1 worktree.");
    } finally {
      console.log = origLog;
    }
  });

  test("prune does not print 'Deleted branch' when git branch -d fails", async () => {
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
          stderr: "",
          exitCode: 0,
        };
      }
      if (cmd.includes("--merged")) return { stdout: "  main\n  feat/orphan\n", stderr: "", exitCode: 0 };
      if (cmd.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("remove")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("-d")) return { stdout: "", stderr: "", exitCode: 1 }; // branch -d fails
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});
    const deps = makeDeps({ callTool, exec, printError, printInfo });

    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["worktrees", "--prune"], deps);
      const errOutput = printError.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      const infoOutput = printInfo.mock.calls.map((c: unknown[]) => c[0]).join("\n");
      expect(infoOutput).toContain("Removed worktree:");
      expect(infoOutput).toContain("Pruned 1 worktree.");
      expect(infoOutput).not.toContain("Deleted branch:");
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
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});
    const deps = makeDeps({ exec, printError, printInfo });

    await cmdClaude(["worktrees"], deps);
    const infoOutput = printInfo.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(infoOutput).toContain("No mcx worktrees found.");
  });

  test("accepts 'wt' alias", async () => {
    const exec: ClaudeDeps["exec"] = mock((cmd: string[]) => {
      if (cmd.includes("list") && cmd.includes("--porcelain")) {
        const cwd = process.cwd();
        return {
          stdout: `worktree ${cwd}\nHEAD abc123\nbranch refs/heads/main\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const printError = mock(() => {});
    const printInfo = mock(() => {});
    const deps = makeDeps({ exec, printError, printInfo });

    await cmdClaude(["wt"], deps);
    const infoOutput = printInfo.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(infoOutput).toContain("No mcx worktrees found.");
  });
});

// ── Resume ──

describe("parseResumeArgs", () => {
  test("parses target positional arg", () => {
    const result = parseResumeArgs(["my-worktree"]);
    expect(result.target).toBe("my-worktree");
    expect(result.all).toBe(false);
    expect(result.error).toBeUndefined();
  });

  test("parses --all flag", () => {
    const result = parseResumeArgs(["--all"]);
    expect(result.all).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("parses --model flag", () => {
    const result = parseResumeArgs(["my-wt", "--model", "sonnet"]);
    expect(result.target).toBe("my-wt");
    expect(result.model).toContain("sonnet");
  });

  test("parses --allow flag", () => {
    const result = parseResumeArgs(["my-wt", "--allow", "Read", "Write"]);
    expect(result.allow).toEqual(["Read", "Write"]);
  });

  test("parses --wait flag", () => {
    const result = parseResumeArgs(["my-wt", "--wait"]);
    expect(result.wait).toBe(true);
  });

  test("parses --timeout flag", () => {
    const result = parseResumeArgs(["my-wt", "--timeout", "60000"]);
    expect(result.timeout).toBe(60000);
  });

  test("parses --fresh flag", () => {
    const result = parseResumeArgs(["my-wt", "--fresh"]);
    expect(result.fresh).toBe(true);
    expect(result.target).toBe("my-wt");
  });

  test("parses second positional as session ID", () => {
    const result = parseResumeArgs(["my-wt", "abc-session-uuid"]);
    expect(result.target).toBe("my-wt");
    expect(result.sessionId).toBe("abc-session-uuid");
  });

  test("defaults fresh to false and sessionId to undefined", () => {
    const result = parseResumeArgs(["my-wt"]);
    expect(result.fresh).toBe(false);
    expect(result.sessionId).toBeUndefined();
  });

  test("errors when no target and no --all", () => {
    const result = parseResumeArgs([]);
    expect(result.error).toBeDefined();
  });

  test("errors on --model without value", () => {
    const result = parseResumeArgs(["my-wt", "--model"]);
    expect(result.error).toBe("--model requires a value");
  });

  test("errors on --timeout without value", () => {
    const result = parseResumeArgs(["my-wt", "--timeout"]);
    expect(result.error).toBe("--timeout requires a value in ms");
  });

  test("errors on --allow without patterns", () => {
    const result = parseResumeArgs(["my-wt", "--allow"]);
    expect(result.error).toBe("--allow requires at least one tool pattern");
  });

  test("errors when --fresh and explicit session ID are both set", () => {
    const result = parseResumeArgs(["my-wt", "abc-session-uuid", "--fresh"]);
    expect(result.error).toBe("--fresh cannot be combined with an explicit session ID");
  });
});

describe("extractIssueNumber", () => {
  test("extracts from feat/issue-N-slug", () => {
    expect(extractIssueNumber("feat/issue-262-claude-resume")).toBe(262);
  });

  test("extracts from fix/issue-N-slug", () => {
    expect(extractIssueNumber("fix/issue-42-some-fix")).toBe(42);
  });

  test("returns null for non-matching branches", () => {
    expect(extractIssueNumber("main")).toBeNull();
    expect(extractIssueNumber("feature/add-auth")).toBeNull();
  });

  test("extracts issue number from middle of branch name", () => {
    expect(extractIssueNumber("refactor/issue-100-cleanup")).toBe(100);
  });
});

describe("resolveWorktree", () => {
  const worktrees = [
    { path: "/repo/.claude/worktrees/claude-abc123", branch: "feat/issue-1-foo" },
    { path: "/repo/.claude/worktrees/claude-def456", branch: "fix/issue-2-bar" },
  ];

  test("resolves by full path", () => {
    const result = resolveWorktree("/repo/.claude/worktrees/claude-abc123", worktrees);
    expect(result).toEqual(worktrees[0]);
  });

  test("resolves by directory name", () => {
    const result = resolveWorktree("claude-def456", worktrees);
    expect(result).toEqual(worktrees[1]);
  });

  test("resolves by branch name", () => {
    const result = resolveWorktree("feat/issue-1-foo", worktrees);
    expect(result).toEqual(worktrees[0]);
  });

  test("returns null for no match", () => {
    const result = resolveWorktree("nonexistent", worktrees);
    expect(result).toBeNull();
  });
});

describe("buildResumePrompt", () => {
  test("includes branch name", () => {
    const prompt = buildResumePrompt({
      branch: "feat/issue-42-auth",
      issueNumber: 42,
      gitLog: "abc1234 add auth module",
      gitDiff: "",
      prInfo: null,
    });
    expect(prompt).toContain("`feat/issue-42-auth`");
    expect(prompt).toContain("#42");
    expect(prompt).toContain("abc1234 add auth module");
  });

  test("includes PR info when present", () => {
    const prompt = buildResumePrompt({
      branch: "feat/issue-1-foo",
      issueNumber: 1,
      gitLog: "",
      gitDiff: "",
      prInfo: "#99 (open)",
    });
    expect(prompt).toContain("#99 (open)");
  });

  test("includes uncommitted changes", () => {
    const prompt = buildResumePrompt({
      branch: "feat/issue-1-foo",
      issueNumber: null,
      gitLog: "",
      gitDiff: " src/index.ts | 5 ++---",
      prInfo: null,
    });
    expect(prompt).toContain("Uncommitted changes");
    expect(prompt).toContain("src/index.ts");
  });

  test("omits empty sections", () => {
    const prompt = buildResumePrompt({
      branch: "feat/foo",
      issueNumber: null,
      gitLog: "",
      gitDiff: "",
      prInfo: null,
    });
    expect(prompt).not.toContain("Commits on this branch");
    expect(prompt).not.toContain("Uncommitted changes");
    expect(prompt).not.toContain("Issue:");
    expect(prompt).not.toContain("PR:");
  });
});

describe("cmdClaude resume", () => {
  const cwd = process.cwd();
  const worktreeParent = `${cwd}/.claude/worktrees`;

  test("errors with no arguments", async () => {
    const deps = makeDeps();
    await expect(cmdClaude(["resume"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalled();
  });

  test("errors when worktree not found", async () => {
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("worktree") && cmd.includes("list")) {
        return { stdout: `worktree ${cwd}\nHEAD abc\nbranch refs/heads/main\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const deps = makeDeps({ exec });
    await expect(cmdClaude(["resume", "nonexistent"], deps)).rejects.toThrow(ExitError);
    const errOutput = (deps.printError as ReturnType<typeof mock>).mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(errOutput).toContain('No worktree matching "nonexistent"');
  });

  test("errors when worktree has active session", async () => {
    const wtPath = `${worktreeParent}/claude-test123`;
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("worktree") && cmd.includes("list")) {
        return {
          stdout: `worktree ${cwd}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${wtPath}\nHEAD def\nbranch refs/heads/feat/issue-1-test\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const callTool = mock(async (tool: string) => {
      if (tool === "claude_session_list") {
        return toolResult([{ sessionId: "s1", state: "active", worktree: "claude-test123" }]);
      }
      return toolResult({});
    });
    const deps = makeDeps({ exec, callTool });
    await expect(cmdClaude(["resume", "claude-test123"], deps)).rejects.toThrow(ExitError);
    const errOutput = (deps.printError as ReturnType<typeof mock>).mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(errOutput).toContain("already has an active session");
  });

  test("skips already-merged branches", async () => {
    const wtPath = `${worktreeParent}/claude-merged`;
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("worktree") && cmd.includes("list")) {
        return {
          stdout: `worktree ${cwd}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${wtPath}\nHEAD def\nbranch refs/heads/feat/issue-5-done\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      if (cmd.includes("--merged")) {
        return { stdout: "  main\n  feat/issue-5-done\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const callTool = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult([]);
      return toolResult({});
    });
    const printError = mock(() => {});
    const deps = makeDeps({ exec, callTool, printError });
    await cmdClaude(["resume", "claude-merged"], deps);
    const errOutput = printError.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(errOutput).toContain("already merged into main");
  });

  test("default resume restores conversation history via resumeSessionId", async () => {
    const wtPath = `${worktreeParent}/claude-orphan`;
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("worktree") && cmd.includes("list")) {
        return {
          stdout: `worktree ${cwd}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${wtPath}\nHEAD def\nbranch refs/heads/feat/issue-42-auth\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      if (cmd.includes("--merged")) {
        return { stdout: "  main\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string, _args: Record<string, unknown>) => {
      if (tool === "claude_session_list") return toolResult([]);
      if (tool === "claude_prompt") return toolResult({ sessionId: "new-session-id", seq: 1 });
      return toolResult({});
    });
    const deps = makeDeps({ exec, callTool });
    await cmdClaude(["resume", "claude-orphan"], deps);

    const promptCall = (callTool as ReturnType<typeof mock>).mock.calls.find(
      (c: unknown[]) => c[0] === "claude_prompt",
    );
    expect(promptCall).toBeDefined();
    const promptArgs = promptCall?.[1] as Record<string, unknown>;
    expect(promptArgs.cwd).toBe(wtPath);
    expect(promptArgs.resumeSessionId).toBe("continue");
    expect(promptArgs.prompt).toContain("restored");
    expect(promptArgs.prompt).toContain("continue where you left off");
  });

  test("resume status message uses console.error without 'Error:' prefix", async () => {
    const wtPath = `${worktreeParent}/claude-orphan`;
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("worktree") && cmd.includes("list")) {
        return {
          stdout: `worktree ${cwd}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${wtPath}\nHEAD def\nbranch refs/heads/feat/issue-42-auth\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      if (cmd.includes("--merged")) {
        return { stdout: "  main\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult([]);
      if (tool === "claude_prompt") return toolResult({ sessionId: "new-session-id", seq: 1 });
      return toolResult({});
    });
    const deps = makeDeps({ exec, callTool });

    const errLines: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: unknown[]) => errLines.push(args.map(String).join(" "));
    try {
      await cmdClaude(["resume", "claude-orphan"], deps);
    } finally {
      console.error = origConsoleError;
    }

    const resumingLine = errLines.find((l) => l.includes("Resuming session"));
    expect(resumingLine).toBeDefined();
    expect(resumingLine).not.toContain("Error:");
    expect(resumingLine).toContain("restoring conversation history");
  });

  test("resume --fresh status message uses console.error without 'Error:' prefix", async () => {
    const wtPath = `${worktreeParent}/claude-orphan`;
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("worktree") && cmd.includes("list")) {
        return {
          stdout: `worktree ${cwd}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${wtPath}\nHEAD def\nbranch refs/heads/feat/issue-42-auth\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      if (cmd.includes("--merged")) return { stdout: "  main\n", stderr: "", exitCode: 0 };
      if (cmd.includes("log")) return { stdout: "abc1234 add auth\n", stderr: "", exitCode: 0 };
      if (cmd.includes("diff")) return { stdout: " src/auth.ts | 3 ++-\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult([]);
      if (tool === "claude_prompt") return toolResult({ sessionId: "new-session-id", seq: 1 });
      return toolResult({});
    });
    const deps = makeDeps({ exec, callTool });

    const errLines: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: unknown[]) => errLines.push(args.map(String).join(" "));
    try {
      await cmdClaude(["resume", "claude-orphan", "--fresh"], deps);
    } finally {
      console.error = origConsoleError;
    }

    const resumingLine = errLines.find((l) => l.includes("Resuming session"));
    expect(resumingLine).toBeDefined();
    expect(resumingLine).not.toContain("Error:");
    expect(resumingLine).toContain("fresh");
  });

  test("resume with explicit session ID passes it as resumeSessionId", async () => {
    const wtPath = `${worktreeParent}/claude-orphan`;
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("worktree") && cmd.includes("list")) {
        return {
          stdout: `worktree ${cwd}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${wtPath}\nHEAD def\nbranch refs/heads/feat/issue-42-auth\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      if (cmd.includes("--merged")) {
        return { stdout: "  main\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string, _args: Record<string, unknown>) => {
      if (tool === "claude_session_list") return toolResult([]);
      if (tool === "claude_prompt") return toolResult({ sessionId: "new-session-id", seq: 1 });
      return toolResult({});
    });
    const deps = makeDeps({ exec, callTool });
    await cmdClaude(["resume", "claude-orphan", "specific-session-uuid"], deps);

    const promptCall = (callTool as ReturnType<typeof mock>).mock.calls.find(
      (c: unknown[]) => c[0] === "claude_prompt",
    );
    expect(promptCall).toBeDefined();
    const promptArgs = promptCall?.[1] as Record<string, unknown>;
    expect(promptArgs.cwd).toBe(wtPath);
    expect(promptArgs.resumeSessionId).toBe("specific-session-uuid");
  });

  test("--fresh flag uses git-context prompt instead of conversation history", async () => {
    const wtPath = `${worktreeParent}/claude-orphan`;
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("worktree") && cmd.includes("list")) {
        return {
          stdout: `worktree ${cwd}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${wtPath}\nHEAD def\nbranch refs/heads/feat/issue-42-auth\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      if (cmd.includes("--merged")) {
        return { stdout: "  main\n", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("log")) {
        return { stdout: "abc1234 add auth module", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("diff")) {
        return { stdout: " src/auth.ts | 3 ++-\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string, _args: Record<string, unknown>) => {
      if (tool === "claude_session_list") return toolResult([]);
      if (tool === "claude_prompt") return toolResult({ sessionId: "new-session-id", seq: 1 });
      return toolResult({});
    });
    const deps = makeDeps({ exec, callTool });
    await cmdClaude(["resume", "claude-orphan", "--fresh"], deps);

    const promptCall = (callTool as ReturnType<typeof mock>).mock.calls.find(
      (c: unknown[]) => c[0] === "claude_prompt",
    );
    expect(promptCall).toBeDefined();
    const promptArgs = promptCall?.[1] as Record<string, unknown>;
    expect(promptArgs.cwd).toBe(wtPath);
    expect(promptArgs.resumeSessionId).toBeUndefined();
    expect(promptArgs.prompt).toContain("feat/issue-42-auth");
    expect(promptArgs.prompt).toContain("#42");
    expect(promptArgs.prompt).toContain("abc1234 add auth module");
  });

  test("--all resumes all orphaned worktrees with conversation history", async () => {
    const wt1 = `${worktreeParent}/claude-wt1`;
    const wt2 = `${worktreeParent}/claude-wt2`;
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("worktree") && cmd.includes("list")) {
        return {
          stdout: [
            `worktree ${cwd}`,
            "HEAD abc",
            "branch refs/heads/main",
            "",
            `worktree ${wt1}`,
            "HEAD def",
            "branch refs/heads/feat/issue-1-foo",
            "",
            `worktree ${wt2}`,
            "HEAD ghi",
            "branch refs/heads/feat/issue-2-bar",
            "",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }
      if (cmd.includes("--merged")) {
        return { stdout: "  main\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string, _args: Record<string, unknown>) => {
      if (tool === "claude_session_list") return toolResult([]);
      if (tool === "claude_prompt") return toolResult({ sessionId: "new-id", seq: 1 });
      return toolResult({});
    });
    const deps = makeDeps({ exec, callTool });
    await cmdClaude(["resume", "--all"], deps);

    // Should have spawned 2 sessions with conversation history restoration
    const promptCalls = (callTool as ReturnType<typeof mock>).mock.calls.filter(
      (c: unknown[]) => c[0] === "claude_prompt",
    );
    expect(promptCalls.length).toBe(2);
    for (const call of promptCalls) {
      const args = (call as unknown[])[1] as Record<string, unknown>;
      expect(args.resumeSessionId).toBe("continue");
    }
  });

  test("--all reports when no orphaned worktrees found", async () => {
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("worktree") && cmd.includes("list")) {
        return { stdout: `worktree ${cwd}\nHEAD abc\nbranch refs/heads/main\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const callTool = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult([]);
      return toolResult({});
    });
    const printError = mock(() => {});
    const deps = makeDeps({ exec, callTool, printError });
    await cmdClaude(["resume", "--all"], deps);
    const errOutput = printError.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(errOutput).toContain("No orphaned worktrees to resume");
  });

  test("passes --model and --allow to spawn", async () => {
    const wtPath = `${worktreeParent}/claude-opts`;
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("worktree") && cmd.includes("list")) {
        return {
          stdout: `worktree ${cwd}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${wtPath}\nHEAD def\nbranch refs/heads/feat/issue-1-test\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      if (cmd.includes("--merged")) return { stdout: "  main\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string, _args: Record<string, unknown>) => {
      if (tool === "claude_session_list") return toolResult([]);
      if (tool === "claude_prompt") return toolResult({ sessionId: "s1", seq: 1 });
      return toolResult({});
    });
    const deps = makeDeps({ exec, callTool });
    await cmdClaude(["resume", "claude-opts", "--model", "sonnet", "--allow", "Read", "Grep"], deps);

    const promptCall = (callTool as ReturnType<typeof mock>).mock.calls.find(
      (c: unknown[]) => c[0] === "claude_prompt",
    );
    const promptArgs = promptCall?.[1] as Record<string, unknown>;
    expect(promptArgs.model).toContain("sonnet");
    expect(promptArgs.allowedTools).toEqual(["Read", "Grep"]);
  });

  test("passes --wait and --timeout to claude_prompt", async () => {
    const wtPath = `${worktreeParent}/claude-wt`;
    const exec = mock((cmd: string[]) => {
      if (cmd.includes("worktree") && cmd.includes("list")) {
        return {
          stdout: `worktree ${cwd}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${wtPath}\nHEAD def\nbranch refs/heads/feat/issue-2-wait\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      if (cmd.includes("--merged")) return { stdout: "  main\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const callTool: ClaudeDeps["callTool"] = mock(async (tool: string, _args: Record<string, unknown>) => {
      if (tool === "claude_session_list") return toolResult([]);
      if (tool === "claude_prompt") return toolResult({ sessionId: "s1", seq: 1 });
      return toolResult({});
    });
    const deps = makeDeps({ exec, callTool });
    await cmdClaude(["resume", "claude-wt", "--wait", "--timeout", "30000"], deps);

    const promptCall = (callTool as ReturnType<typeof mock>).mock.calls.find(
      (c: unknown[]) => c[0] === "claude_prompt",
    );
    const promptArgs = promptCall?.[1] as Record<string, unknown>;
    expect(promptArgs.wait).toBe(true);
    expect(promptArgs.timeout).toBe(30000);
  });
});
// ── formatQuotaBanner ──

describe("formatQuotaBanner", () => {
  const makeQuota = (utilization: number, resetsAt = "2026-04-08T20:00:00Z") => ({
    fiveHour: { utilization, resetsAt },
    sevenDay: null,
    sevenDaySonnet: null,
    sevenDayOpus: null,
    extraUsage: null,
    fetchedAt: Date.now(),
    lastError: null,
  });

  test("returns null when quota is null", () => {
    expect(formatQuotaBanner(null)).toBeNull();
  });

  test("returns null when fetchedAt is 0", () => {
    expect(formatQuotaBanner({ ...makeQuota(90), fetchedAt: 0 })).toBeNull();
  });

  test("returns null when fiveHour is null", () => {
    expect(formatQuotaBanner({ ...makeQuota(90), fiveHour: null })).toBeNull();
  });

  test("returns null at 80% (threshold is >80)", () => {
    expect(formatQuotaBanner(makeQuota(80))).toBeNull();
  });

  test("returns warning at 81%", () => {
    const banner = formatQuotaBanner(makeQuota(81));
    expect(banner).toContain("81%");
    expect(banner).toContain("stop spawning new sessions");
  });

  test("returns critical at 95%", () => {
    const banner = formatQuotaBanner(makeQuota(95));
    expect(banner).toContain("95%");
    expect(banner).toContain("pause all spawning");
    expect(banner).toContain("CRITICAL");
  });

  test("returns critical at 100%", () => {
    const banner = formatQuotaBanner(makeQuota(100));
    expect(banner).toContain("CRITICAL");
  });

  test("warning tier does not say CRITICAL", () => {
    const banner = formatQuotaBanner(makeQuota(87));
    expect(banner).not.toBeNull();
    expect(banner).not.toContain("CRITICAL");
    expect(banner).toContain("87%");
    expect(banner).toContain("resets");
  });
});

// ── approve / deny ──

const SESSION_LIST_WITH_PERMS = [
  {
    ...SESSION_LIST[0],
    pendingPermissionDetails: [
      { requestId: "req-oldest", toolName: "Bash", inputSummary: "command=ls" },
      { requestId: "req-latest", toolName: "Write", inputSummary: "file_path=/tmp/x" },
    ],
    pendingPermissions: 2,
  },
  SESSION_LIST[1],
];

describe("parseApproveArgs", () => {
  const d = {
    printError: mock(() => {}),
    exit: mock(() => {
      throw new ExitError(1);
    }) as never,
  };

  test("parses positional session + request-id (legacy)", () => {
    const result = parseApproveArgs(["abc", "req-001"], d);
    expect(result).toEqual({ sessionPrefix: "abc", requestId: "req-001" });
  });

  test("parses --request-id flag", () => {
    const result = parseApproveArgs(["abc", "--request-id", "req-002"], d);
    expect(result).toEqual({ sessionPrefix: "abc", requestId: "req-002" });
  });

  test("parses -r shorthand", () => {
    const result = parseApproveArgs(["abc", "-r", "req-003"], d);
    expect(result).toEqual({ sessionPrefix: "abc", requestId: "req-003" });
  });

  test("session-only (no request-id) returns undefined requestId", () => {
    const result = parseApproveArgs(["abc"], d);
    expect(result).toEqual({ sessionPrefix: "abc", requestId: undefined });
  });

  test("errors when missing session-id", () => {
    expect(() => parseApproveArgs([], d)).toThrow(ExitError);
  });
});

describe("parseDenyArgs", () => {
  const d = {
    printError: mock(() => {}),
    exit: mock(() => {
      throw new ExitError(1);
    }) as never,
  };

  test("parses positional session + request-id (legacy)", () => {
    const result = parseDenyArgs(["abc", "req-001"], d);
    expect(result).toEqual({ sessionPrefix: "abc", requestId: "req-001", message: undefined });
  });

  test("parses --request-id flag with --message", () => {
    const result = parseDenyArgs(["abc", "--request-id", "req-002", "--message", "Nope"], d);
    expect(result).toEqual({ sessionPrefix: "abc", requestId: "req-002", message: "Nope" });
  });

  test("parses -r and -m shorthands", () => {
    const result = parseDenyArgs(["abc", "-r", "req-003", "-m", "No"], d);
    expect(result).toEqual({ sessionPrefix: "abc", requestId: "req-003", message: "No" });
  });

  test("session-only with --message", () => {
    const result = parseDenyArgs(["abc", "-m", "Bad idea"], d);
    expect(result).toEqual({ sessionPrefix: "abc", requestId: undefined, message: "Bad idea" });
  });

  test("errors when missing session-id", () => {
    expect(() => parseDenyArgs([], d)).toThrow(ExitError);
  });
});

describe("mcx claude approve", () => {
  test("calls claude_approve with explicit positional requestId (legacy)", async () => {
    const callTool = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ approved: true });
    });
    const deps = makeDeps({ callTool });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["approve", "abc", "req-001"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_approve", {
        sessionId: SESSION_LIST[0].sessionId,
        requestId: "req-001",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("calls claude_approve with --request-id flag", async () => {
    const callTool = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ approved: true });
    });
    const deps = makeDeps({ callTool });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["approve", "abc", "--request-id", "req-flag"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_approve", {
        sessionId: SESSION_LIST[0].sessionId,
        requestId: "req-flag",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("auto-resolves latest pending request when no requestId", async () => {
    const callTool = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST_WITH_PERMS);
      return toolResult({ approved: true });
    });
    const deps = makeDeps({ callTool });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["approve", "abc"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_approve", {
        sessionId: SESSION_LIST[0].sessionId,
        requestId: "req-latest",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("errors when no pending permissions and no requestId", async () => {
    const callTool = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ approved: true });
    });
    const deps = makeDeps({ callTool });
    await expect(cmdClaude(["approve", "abc"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("No pending permission"));
  });

  test("errors when missing session-id", async () => {
    const deps = makeDeps();
    await expect(cmdClaude(["approve"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });
});

describe("mcx claude deny", () => {
  test("calls claude_deny with explicit positional requestId (legacy)", async () => {
    const callTool = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ denied: true });
    });
    const deps = makeDeps({ callTool });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["deny", "abc", "req-001"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_deny", {
        sessionId: SESSION_LIST[0].sessionId,
        requestId: "req-001",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("auto-resolves latest pending request when no requestId", async () => {
    const callTool = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST_WITH_PERMS);
      return toolResult({ denied: true });
    });
    const deps = makeDeps({ callTool });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["deny", "abc"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_deny", {
        sessionId: SESSION_LIST[0].sessionId,
        requestId: "req-latest",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("passes --message with auto-resolved requestId", async () => {
    const callTool = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST_WITH_PERMS);
      return toolResult({ denied: true });
    });
    const deps = makeDeps({ callTool });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["deny", "abc", "--message", "Not allowed"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_deny", {
        sessionId: SESSION_LIST[0].sessionId,
        requestId: "req-latest",
        message: "Not allowed",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("passes --message to deny tool with explicit requestId", async () => {
    const callTool = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ denied: true });
    });
    const deps = makeDeps({ callTool });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["deny", "abc", "req-001", "--message", "Not allowed"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_deny", {
        sessionId: SESSION_LIST[0].sessionId,
        requestId: "req-001",
        message: "Not allowed",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("passes -m shorthand to deny tool", async () => {
    const callTool = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ denied: true });
    });
    const deps = makeDeps({ callTool });
    const origLog = console.log;
    console.log = mock(() => {});
    try {
      await cmdClaude(["deny", "abc", "req-001", "-m", "Nope"], deps);
      expect(callTool).toHaveBeenCalledWith("claude_deny", {
        sessionId: SESSION_LIST[0].sessionId,
        requestId: "req-001",
        message: "Nope",
      });
    } finally {
      console.log = origLog;
    }
  });

  test("errors when missing session-id", async () => {
    const deps = makeDeps();
    await expect(cmdClaude(["deny"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  test("errors when no pending permissions and no requestId", async () => {
    const callTool = mock(async (tool: string) => {
      if (tool === "claude_session_list") return toolResult(SESSION_LIST);
      return toolResult({ denied: true });
    });
    const deps = makeDeps({ callTool });
    await expect(cmdClaude(["deny", "abc"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("No pending permission"));
  });
});

// ── help alias normalization ──

describe("mcx claude <alias> --help", () => {
  test("list --help resolves to ls help", async () => {
    const deps = makeDeps();
    await cmdClaude(["list", "--help"], deps);
    const output = logCalls(deps).join("\n");
    expect(output).toContain("mcx claude ls");
    expect(output).not.toContain("No detailed help available");
  });

  test("quit --help resolves to bye help", async () => {
    const deps = makeDeps();
    await cmdClaude(["quit", "--help"], deps);
    const output = logCalls(deps).join("\n");
    expect(output).toContain("mcx claude bye");
    expect(output).not.toContain("No detailed help available");
  });

  test("wt --help resolves to worktrees help", async () => {
    const deps = makeDeps();
    await cmdClaude(["wt", "--help"], deps);
    const output = logCalls(deps).join("\n");
    expect(output).toContain("mcx claude worktrees");
    expect(output).not.toContain("No detailed help available");
  });
});

describe("mcx claude patch-update", () => {
  test("noop status logs the reason without exit code", async () => {
    const deps = makeDeps();
    await cmdClaude(["patch-update"], deps);
    expect(logCalls(deps).join("\n")).toContain("needs no patch");
    expect(deps.exit).not.toHaveBeenCalled();
  });

  test("patched status logs the destination + strategy + source hash", async () => {
    const deps = makeDeps({
      runPatchUpdate: mock(async () => ({
        status: "patched" as const,
        version: "2.1.121",
        strategyId: "host-check-ipv6-loopback-v1",
        sourcePath: "/usr/local/bin/claude",
        sourceHash: "deadbeefcafebabe1234567890abcdef",
        patchedPath: "/x/2.1.121.patched",
        currentLink: "/x/current",
      })),
    });
    await cmdClaude(["patch-update"], deps);
    const out = logCalls(deps).join("\n");
    expect(out).toContain("Patched claude 2.1.121");
    expect(out).toContain("host-check-ipv6-loopback-v1");
    expect(out).toContain("deadbeefcafe"); // truncated sha prefix
  });

  test("already-current status hints --force", async () => {
    const deps = makeDeps({
      runPatchUpdate: mock(async () => ({
        status: "already-current" as const,
        version: "2.1.121",
        strategyId: "host-check-ipv6-loopback-v1",
        sourcePath: "/usr/local/bin/claude",
        sourceHash: "abc",
        patchedPath: "/x/2.1.121.patched",
        currentLink: "/x/current",
      })),
    });
    await cmdClaude(["patch-update"], deps);
    expect(logCalls(deps).join("\n")).toContain("already patched");
    expect(logCalls(deps).join("\n")).toContain("--force");
  });

  test("unsupported status exits 2 with the patcher's reason", async () => {
    const deps = makeDeps({
      runPatchUpdate: mock(async () => ({
        status: "unsupported" as const,
        version: "9.9.9",
        sourcePath: "/usr/local/bin/claude",
        sourceHash: "abc",
        reason: "No patch strategy registered for claude 9.9.9.",
      })),
    });
    await expect(cmdClaude(["patch-update"], deps)).rejects.toThrow(ExitError);
    const errCalls = (deps.printError as Mock<(s: string) => void>).mock.calls.map((c) => c[0]);
    expect(errCalls.some((s) => s.includes("9.9.9"))).toBe(true);
    expect(errCalls.some((s) => s.includes("No patch strategy"))).toBe(true);
    expect(deps.exit).toHaveBeenCalledWith(2);
  });

  test("patcher exception exits 1 with formatted error", async () => {
    const deps = makeDeps({
      runPatchUpdate: mock(async () => {
        throw new Error("boom");
      }),
    });
    await expect(cmdClaude(["patch-update"], deps)).rejects.toThrow(ExitError);
    const errCalls = (deps.printError as Mock<(s: string) => void>).mock.calls.map((c) => c[0]);
    expect(errCalls.some((s) => s.includes("patch-update failed: boom"))).toBe(true);
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  test("--json prints the outcome as JSON without human-readable lines", async () => {
    const deps = makeDeps();
    const captured: string[] = [];
    const origLog = console.log;
    console.log = (s: string) => {
      captured.push(s);
    };
    try {
      await cmdClaude(["patch-update", "--json"], deps);
    } finally {
      console.log = origLog;
    }
    expect(captured.length).toBe(1);
    const parsed = JSON.parse(captured[0]);
    expect(parsed.status).toBe("noop");
  });

  test("--force is forwarded to the patcher", async () => {
    const calls: Array<{ force?: boolean; sourcePath?: string }> = [];
    const deps = makeDeps({
      runPatchUpdate: mock(async (opts) => {
        calls.push({ force: opts?.force, sourcePath: opts?.sourcePath });
        return {
          status: "noop" as const,
          version: "2.1.119",
          strategyId: "noop-pre-2.1.120",
          sourcePath: opts?.sourcePath ?? "/usr/local/bin/claude",
          sourceHash: "x",
          reason: "no patch needed",
        };
      }),
    });
    await cmdClaude(["patch-update", "--force"], deps);
    expect(calls[0].force).toBe(true);
  });

  test("--source <path> overrides the default source binary", async () => {
    const calls: Array<{ sourcePath?: string }> = [];
    const deps = makeDeps({
      runPatchUpdate: mock(async (opts) => {
        calls.push({ sourcePath: opts?.sourcePath });
        return {
          status: "noop" as const,
          version: "2.1.119",
          strategyId: "noop-pre-2.1.120",
          sourcePath: opts?.sourcePath ?? "/usr/local/bin/claude",
          sourceHash: "x",
          reason: "no patch needed",
        };
      }),
    });
    await cmdClaude(["patch-update", "--source", "/custom/claude"], deps);
    expect(calls[0].sourcePath).toBe("/custom/claude");
  });

  test("--source=<path> form is also accepted", async () => {
    const calls: Array<{ sourcePath?: string }> = [];
    const deps = makeDeps({
      runPatchUpdate: mock(async (opts) => {
        calls.push({ sourcePath: opts?.sourcePath });
        return {
          status: "noop" as const,
          version: "2.1.119",
          strategyId: "noop-pre-2.1.120",
          sourcePath: opts?.sourcePath ?? "/usr/local/bin/claude",
          sourceHash: "x",
          reason: "no patch needed",
        };
      }),
    });
    await cmdClaude(["patch-update", "--source=/abs/claude"], deps);
    expect(calls[0].sourcePath).toBe("/abs/claude");
  });

  test("unknown argument exits 1 with a helpful error", async () => {
    const deps = makeDeps();
    await expect(cmdClaude(["patch-update", "--bogus"], deps)).rejects.toThrow(ExitError);
    const errCalls = (deps.printError as Mock<(s: string) => void>).mock.calls.map((c) => c[0]);
    expect(errCalls.some((s) => s.includes("--bogus"))).toBe(true);
  });
});
