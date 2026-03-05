import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { isProcessMcpd, resolveDaemonCommand } from "./ipc-client";

describe("resolveDaemonCommand", () => {
  test("returns array starting with 'bun' in dev mode", () => {
    const cmd = resolveDaemonCommand();
    // In the source tree, dev mode should be detected
    expect(cmd[0]).toBe("bun");
    expect(cmd[1]).toBe("run");
    expect(cmd.length).toBe(3);
  });

  test("returned dev script path actually exists on disk", () => {
    const cmd = resolveDaemonCommand();
    // cmd[2] is the resolved daemon script path
    expect(existsSync(cmd[2])).toBe(true);
  });
});

describe("isProcessMcpd", () => {
  test("returns false for non-existent PID", () => {
    expect(isProcessMcpd(999999)).toBe(false);
  });

  test("returns false for current process (not mcpd)", () => {
    expect(isProcessMcpd(process.pid)).toBe(false);
  });
});
