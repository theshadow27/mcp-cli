import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonStatus, MetricsSnapshot } from "@mcp-cli/core";
import { type DumpDeps, cmdDump } from "./dump";

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
    expect(parsed.daemon).toBeNull();
    expect(parsed.metrics).toBeNull();
    expect(parsed.daemonLog).toBeNull();
    expect(parsed.sessions).toBeNull();
    expect(parsed.timestamp).toBeString();
  });

  test("gathers process list filtering for mcp/claude", async () => {
    const deps = makeDeps({
      dumpsDir: tempDir,
      exec: mock((cmd: string[]) => {
        if (cmd[0] === "ps") {
          return {
            stdout: [
              "USER  PID  %CPU  %MEM  COMMAND",
              "user  100  0.5   1.0   mcpd --daemon",
              "user  101  0.1   0.5   node some-other-thing",
              "user  102  0.2   0.3   mcx claude ls",
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
    expect(parsed.processes).toHaveLength(3); // header + 2 matching lines
    expect(parsed.processes[0]).toContain("USER");
    expect(parsed.processes[1]).toContain("mcpd");
    expect(parsed.processes[2]).toContain("mcx");
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
