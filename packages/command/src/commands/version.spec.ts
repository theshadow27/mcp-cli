import { describe, expect, test } from "bun:test";
import type { DaemonStatus } from "@mcp-cli/core";
import { cmdVersion } from "./version";

function mockDaemonStatus(overrides?: Partial<DaemonStatus>): DaemonStatus {
  return {
    pid: 12345,
    uptime: 9091, // 2h31m11s
    protocolVersion: "a3f2b1c9d0e1",
    daemonVersion: "0.1.0-20260308",
    servers: [],
    dbPath: "/tmp/state.db",
    usageStats: [],
    ...overrides,
  };
}

const mockDeps = {
  buildVersion: "0.1.0-20260308",
  protocolVersion: "a3f2b1c9d0e1",
  exit: (() => {}) as never,
};

async function captureOutput(fn: () => Promise<void>): Promise<{ stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { stdout, stderr };
}

describe("cmdVersion", () => {
  test("shows client info and daemon info on protocol match", async () => {
    const { stdout } = await captureOutput(() =>
      cmdVersion([], {
        ...mockDeps,
        ipcCall: async () => mockDaemonStatus() as never,
      }),
    );
    expect(stdout[0]).toContain("mcx 0.1.0-20260308");
    expect(stdout[0]).toContain("protocol: a3f2b1c9d0e1");
    expect(stdout[1]).toContain("mcpd 0.1.0-20260308");
    expect(stdout[1]).toContain("protocol: a3f2b1c9d0e1");
    expect(stdout[2]).toBe("Status:  protocol match");
  });

  test("shows MISMATCH when protocol versions differ", async () => {
    const { stdout } = await captureOutput(() =>
      cmdVersion([], {
        ...mockDeps,
        protocolVersion: "aabbccddeeff",
        ipcCall: async () => mockDaemonStatus({ protocolVersion: "112233445566" }) as never,
      }),
    );
    expect(stdout[2]).toContain("MISMATCH");
    expect(stdout[2]).toContain("bun build");
  });

  test("shows '(not running)' when daemon is offline", async () => {
    const { stdout } = await captureOutput(() =>
      cmdVersion([], {
        ...mockDeps,
        ipcCall: async () => {
          throw new Error("connection refused");
        },
      }),
    );
    expect(stdout[0]).toContain("mcx 0.1.0-20260308");
    expect(stdout[1]).toContain("(not running)");
    expect(stdout[2]).toContain("offline");
  });

  test("--json outputs structured JSON with protocol match", async () => {
    const { stdout } = await captureOutput(() =>
      cmdVersion(["--json"], {
        ...mockDeps,
        ipcCall: async () => mockDaemonStatus() as never,
      }),
    );
    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.client.version).toBe("0.1.0-20260308");
    expect(parsed.client.protocol).toBe("a3f2b1c9d0e1");
    expect(parsed.daemon.version).toBe("0.1.0-20260308");
    expect(parsed.daemon.protocol).toBe("a3f2b1c9d0e1");
    expect(parsed.daemon.uptimeSeconds).toBeGreaterThan(0);
    expect(parsed.protocolMatch).toBe(true);
  });

  test("--json with protocol mismatch sets protocolMatch false", async () => {
    const { stdout } = await captureOutput(() =>
      cmdVersion(["--json"], {
        ...mockDeps,
        protocolVersion: "aabbccddeeff",
        ipcCall: async () => mockDaemonStatus({ protocolVersion: "112233445566" }) as never,
      }),
    );
    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.protocolMatch).toBe(false);
  });

  test("-j is shorthand for --json", async () => {
    const { stdout } = await captureOutput(() =>
      cmdVersion(["-j"], {
        ...mockDeps,
        ipcCall: async () => mockDaemonStatus() as never,
      }),
    );
    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.client).toBeDefined();
  });

  test("--json with daemon offline shows null daemon and null protocolMatch", async () => {
    const { stdout } = await captureOutput(() =>
      cmdVersion(["--json"], {
        ...mockDeps,
        ipcCall: async () => {
          throw new Error("not running");
        },
      }),
    );
    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.daemon).toBeNull();
    expect(parsed.protocolMatch).toBeNull();
  });

  test("uptime formats correctly for days", async () => {
    const { stdout } = await captureOutput(() =>
      cmdVersion([], {
        ...mockDeps,
        ipcCall: async () => mockDaemonStatus({ uptime: 14 * 86400 + 3600 }) as never,
      }),
    );
    expect(stdout[1]).toContain("14d1h");
  });

  test("uptime formats correctly for minutes only", async () => {
    const { stdout } = await captureOutput(() =>
      cmdVersion([], {
        ...mockDeps,
        ipcCall: async () => mockDaemonStatus({ uptime: 185 }) as never,
      }),
    );
    expect(stdout[1]).toContain("3m");
  });

  test("uptime formats correctly for seconds only", async () => {
    const { stdout } = await captureOutput(() =>
      cmdVersion([], {
        ...mockDeps,
        ipcCall: async () => mockDaemonStatus({ uptime: 45 }) as never,
      }),
    );
    expect(stdout[1]).toContain("45s");
  });

  test("daemon without daemonVersion shows 'unknown'", async () => {
    const { stdout } = await captureOutput(() =>
      cmdVersion([], {
        ...mockDeps,
        ipcCall: async () => mockDaemonStatus({ daemonVersion: undefined }) as never,
      }),
    );
    expect(stdout[1]).toContain("unknown");
  });
});
