import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonStatus, MetricsSnapshot } from "@mcp-cli/core";
import { type DumpDeps, type GatherError, cmdDump, isGatherError } from "./dump";

const fakeDaemonStatus: DaemonStatus = {
  pid: 12345,
  uptime: 3600,
  protocolVersion: "abc123",
  daemonVersion: "0.1.0-test",
  servers: [
    {
      name: "test-server",
      transport: "stdio",
      state: "connected",
      toolCount: 3,
      source: "user",
    },
  ],
  dbPath: "/tmp/test/state.db",
  usageStats: [],
};

const fakeMetrics: MetricsSnapshot = {
  collectedAt: Date.now(),
  counters: [{ name: "requests_total", labels: {}, value: 42 }],
  gauges: [],
  histograms: [],
};

const fakeDaemonLogs = {
  lines: [
    { timestamp: Date.now(), line: "daemon started" },
    { timestamp: Date.now(), line: "server connected" },
  ],
};

const fakeSessions = [
  {
    sessionId: "sess-1",
    state: "active",
    model: "opus",
    cwd: "/tmp",
    cost: 0.5,
    tokens: 1000,
    numTurns: 3,
    pendingPermissions: 0,
    pendingPermissionDetails: [],
    worktree: "test-wt",
    wsConnected: true,
    spawnAlive: true,
  },
];

function makeDeps(overrides?: Partial<DumpDeps>): DumpDeps {
  const dumpsDir = join(tmpdir(), `mcx-dump-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return {
    ipcCall: mock(async (method: string, params?: unknown) => {
      if (method === "status") return fakeDaemonStatus;
      if (method === "getMetrics") return fakeMetrics;
      if (method === "getDaemonLogs") return fakeDaemonLogs;
      if (method === "callTool") {
        const p = params as { tool: string };
        if (p.tool === "claude_session_list") {
          return { content: [{ type: "text", text: JSON.stringify(fakeSessions) }] };
        }
        if (p.tool === "claude_session_log") {
          return { content: [{ type: "text", text: "line1\nline2\nline3" }] };
        }
      }
      return {};
    }) as DumpDeps["ipcCall"],
    printError: mock(() => {}),
    exit: mock((code: number) => {
      throw new Error(`exit(${code})`);
    }) as unknown as DumpDeps["exit"],
    exec: mock(() => ({ stdout: "", exitCode: 0 })),
    checkPid: mock(() => true),
    dumpsDir,
    ...overrides,
  };
}

describe("cmdDump", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `mcx-dump-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  test("--stdout prints JSON to stdout", async () => {
    const deps = makeDeps({ dumpsDir: tempDir });
    const origLog = console.log;
    let output = "";
    console.log = (msg: string) => {
      output += msg;
    };
    try {
      await cmdDump(["--stdout"], deps);
    } finally {
      console.log = origLog;
    }

    const parsed = JSON.parse(output);
    expect(parsed.timestamp).toBeString();
    expect(parsed.daemon.pid).toBe(12345);
    expect(parsed.daemon.uptime).toBe(3600);
    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0].name).toBe("test-server");
    expect(parsed.metrics.counters).toHaveLength(1);
    expect(parsed.daemonLog).toHaveLength(2);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].sessionId).toBe("sess-1");
  });

  test("writes dump file to dumpsDir when no --stdout", async () => {
    const deps = makeDeps({ dumpsDir: tempDir });
    const origError = console.error;
    let errOutput = "";
    console.error = (msg: string) => {
      errOutput += msg;
    };
    try {
      await cmdDump([], deps);
    } finally {
      console.error = origError;
    }

    expect(errOutput).toContain("Dump written to");
    expect(errOutput).toContain(tempDir);

    // Verify file exists and is valid JSON
    const files = Bun.file(join(tempDir)).name;
    const entries = require("node:fs").readdirSync(tempDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^dump-.*\.json$/);

    const content = readFileSync(join(tempDir, entries[0]), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.daemon.pid).toBe(12345);
  });

  test("creates dumpsDir if it does not exist", async () => {
    const newDir = join(tempDir, "nested", "dumps");
    const deps = makeDeps({ dumpsDir: newDir });
    const origError = console.error;
    console.error = () => {};
    try {
      await cmdDump([], deps);
    } finally {
      console.error = origError;
    }

    expect(existsSync(newDir)).toBe(true);
  });

  test("--include-transcripts adds transcript to sessions", async () => {
    const deps = makeDeps({ dumpsDir: tempDir });
    const origLog = console.log;
    let output = "";
    console.log = (msg: string) => {
      output += msg;
    };
    try {
      await cmdDump(["--stdout", "--include-transcripts"], deps);
    } finally {
      console.log = origLog;
    }

    const parsed = JSON.parse(output);
    expect(parsed.sessions[0].transcript).toEqual(["line1", "line2", "line3"]);
  });

  test("handles daemon not running gracefully", async () => {
    const deps = makeDeps({
      dumpsDir: tempDir,
      ipcCall: mock(async () => {
        throw new Error("Connection refused");
      }) as DumpDeps["ipcCall"],
    });
    const origLog = console.log;
    let output = "";
    console.log = (msg: string) => {
      output += msg;
    };
    try {
      await cmdDump(["--stdout"], deps);
    } finally {
      console.log = origLog;
    }

    const parsed = JSON.parse(output);
    expect(isGatherError(parsed.daemon)).toBe(true);
    expect((parsed.daemon as GatherError).error).toBe("Connection refused");
    expect((parsed.daemon as GatherError).gatheredAt).toBeString();
    expect(isGatherError(parsed.metrics)).toBe(true);
    expect(isGatherError(parsed.daemonLog)).toBe(true);
    expect(isGatherError(parsed.sessions)).toBe(true);
    expect(parsed.timestamp).toBeString();
  });

  test("daemonProcess uses checkPid to verify liveness, not ps aux", async () => {
    const checkPid = mock(() => true);
    const exec = mock((cmd: string[]) => {
      // exec should NEVER be called with ps
      if (cmd[0] === "ps") throw new Error("ps aux must not be called");
      return { stdout: "", exitCode: 0 };
    });
    const deps = makeDeps({ dumpsDir: tempDir, checkPid, exec });

    const origLog = console.log;
    let output = "";
    console.log = (msg: string) => {
      output += msg;
    };
    try {
      await cmdDump(["--stdout"], deps);
    } finally {
      console.log = origLog;
    }

    const parsed = JSON.parse(output);
    expect(parsed.daemonProcess).toEqual({ pid: 12345, alive: true });
    expect(checkPid).toHaveBeenCalledWith(12345);
    expect(parsed.processes).toBeUndefined(); // old field gone
  });

  test("daemonProcess is null when daemon is not running", async () => {
    const checkPid = mock(() => false);
    const deps = makeDeps({
      dumpsDir: tempDir,
      checkPid,
      ipcCall: mock(async () => {
        throw new Error("Connection refused");
      }) as DumpDeps["ipcCall"],
    });

    const origLog = console.log;
    let output = "";
    console.log = (msg: string) => {
      output += msg;
    };
    try {
      await cmdDump(["--stdout"], deps);
    } finally {
      console.log = origLog;
    }

    const parsed = JSON.parse(output);
    expect(parsed.daemonProcess).toBeNull();
    expect(checkPid).not.toHaveBeenCalled();
  });

  test("transcript failure for one session does not abort others", async () => {
    const sessions = [
      { ...fakeSessions[0], sessionId: "sess-1" },
      { ...fakeSessions[0], sessionId: "sess-2" },
      { ...fakeSessions[0], sessionId: "sess-3" },
    ];
    const deps = makeDeps({
      dumpsDir: tempDir,
      ipcCall: mock(async (method: string, params?: unknown) => {
        if (method === "status") return fakeDaemonStatus;
        if (method === "getMetrics") return fakeMetrics;
        if (method === "getDaemonLogs") return fakeDaemonLogs;
        if (method === "callTool") {
          const p = params as { tool: string; arguments?: { sessionId?: string } };
          if (p.tool === "claude_session_list") {
            return { content: [{ type: "text", text: JSON.stringify(sessions) }] };
          }
          if (p.tool === "claude_session_log") {
            // sess-2 fails
            if (p.arguments?.sessionId === "sess-2") throw new Error("timeout");
            return { content: [{ type: "text", text: "line1\nline2" }] };
          }
        }
        return {};
      }) as DumpDeps["ipcCall"],
    });

    const origLog = console.log;
    let output = "";
    console.log = (msg: string) => {
      output += msg;
    };
    try {
      await cmdDump(["--stdout", "--include-transcripts"], deps);
    } finally {
      console.log = origLog;
    }

    const parsed = JSON.parse(output);
    expect(parsed.sessions).toHaveLength(3);
    expect(parsed.sessions[0].transcript).toEqual(["line1", "line2"]);
    expect(parsed.sessions[1].transcript).toEqual(["(unavailable)"]);
    expect(parsed.sessions[2].transcript).toEqual(["line1", "line2"]);
  });

  test("gathers worktree list", async () => {
    const deps = makeDeps({
      dumpsDir: tempDir,
      exec: mock((cmd: string[]) => {
        if (cmd[0] === "git") {
          return {
            stdout: [
              "worktree /Users/test/repo",
              "HEAD abc123",
              "branch refs/heads/main",
              "",
              "worktree /Users/test/repo/.claude/worktrees/test-wt",
              "HEAD def456",
              "branch refs/heads/feat/test",
              "",
            ].join("\n"),
            exitCode: 0,
          };
        }
        return { stdout: "", exitCode: 0 };
      }),
    });

    const origLog = console.log;
    let output = "";
    console.log = (msg: string) => {
      output += msg;
    };
    try {
      await cmdDump(["--stdout"], deps);
    } finally {
      console.log = origLog;
    }

    const parsed = JSON.parse(output);
    expect(parsed.worktrees).toHaveLength(2);
    expect(parsed.worktrees[0]).toEqual({ path: "/Users/test/repo", branch: "main" });
    expect(parsed.worktrees[1]).toEqual({ path: "/Users/test/repo/.claude/worktrees/test-wt", branch: "feat/test" });
  });
});
