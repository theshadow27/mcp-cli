import { describe, expect, test } from "bun:test";
import { findPidsByCwdLinux, getPortHolderLinux, parseListenInodes } from "./proc-fs";

const POLL_INTERVAL_MS = 10;
const VISIBILITY_DEADLINE_MS = 2_000;

const SAMPLE_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 00000000 100 0 0 10 0
   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 67890 1 00000000 100 0 0 10 0
   2: 0100007F:1F90 00000000:0000 01 00000000:00000000 00:00000000 00000000     0        0 99999 1 00000000 100 0 0 10 0
`;

describe("parseListenInodes", () => {
  test("picks LISTEN sockets on the requested port and ignores other states", () => {
    // 0x1F90 = 8080
    expect(parseListenInodes(SAMPLE_TCP, 8080)).toEqual([67890]);
    // 0x0050 = 80
    expect(parseListenInodes(SAMPLE_TCP, 80)).toEqual([12345]);
    expect(parseListenInodes(SAMPLE_TCP, 443)).toEqual([]);
  });
});

describe("findPidsByCwdLinux", () => {
  test.skipIf(process.platform !== "linux")("finds a process whose cwd is under the given directory", async () => {
    const { mkdirSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "mcx-proc-cwd-"));
    mkdirSync(dir, { recursive: true });
    const proc = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore", cwd: dir });
    try {
      const deadline = Date.now() + VISIBILITY_DEADLINE_MS;
      let pids: number[] = [];
      while (Date.now() < deadline) {
        pids = findPidsByCwdLinux(dir);
        if (pids.includes(proc.pid)) break;
        await Bun.sleep(POLL_INTERVAL_MS);
      }
      expect(pids).toContain(proc.pid);
      expect(pids).not.toContain(process.pid);
    } finally {
      try {
        process.kill(proc.pid, "SIGKILL");
        // dotw-ignore test-empty-catch: best-effort cleanup — process may already be gone
      } catch {
        // already gone
      }
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("getPortHolderLinux", () => {
  test.skipIf(process.platform !== "linux")("identifies the process listening on a local port", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      const port = server.port;
      if (port === undefined) throw new Error("server.port is undefined");
      const result = getPortHolderLinux(port);
      expect(result).not.toBeNull();
      expect(result).toContain("PID");
    } finally {
      server.stop(true);
    }
  });
});
