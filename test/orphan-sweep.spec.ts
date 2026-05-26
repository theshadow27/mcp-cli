import { describe, expect, test } from "bun:test";
import { type PsEntry, findOrphans, parsePs } from "./orphan-sweep";

describe("parsePs", () => {
  test("parses ps -eo pid,ppid,command output", () => {
    const output = [
      "  PID  PPID COMMAND",
      "    1     0 /sbin/launchd",
      "  123     1 bun test --test-worker",
      "  456   789 bun test/echo-server.ts",
      "",
    ].join("\n");

    expect(parsePs(output)).toEqual([
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 123, ppid: 1, command: "bun test --test-worker" },
      { pid: 456, ppid: 789, command: "bun test/echo-server.ts" },
    ]);
  });

  test("handles empty output", () => {
    expect(parsePs("")).toEqual([]);
  });
});

describe("findOrphans", () => {
  const SELF_PID = 99999;

  const entries: PsEntry[] = [
    { pid: 1, ppid: 0, command: "/sbin/launchd" },
    { pid: 100, ppid: 1, command: "bun test --test-worker" },
    { pid: 101, ppid: 1, command: "bun test/echo-server.ts" },
    { pid: 102, ppid: 1, command: "bun test/echo-http-server.ts" },
    { pid: 103, ppid: 1, command: "bun test/echo-sse-server.ts" },
    { pid: 104, ppid: 1, command: "bun test/slow-echo-server.ts" },
    { pid: 105, ppid: 1, command: "bun test/http-401-server.ts" },
    { pid: 200, ppid: 50, command: "bun test --test-worker" },
    { pid: 300, ppid: 1, command: "/usr/bin/mcpd" },
    { pid: 400, ppid: 1, command: "bun packages/daemon/src/main.ts" },
    { pid: 500, ppid: 1, command: "node something-else" },
  ];

  test("selects only PPID-1 processes matching test patterns", () => {
    const orphans = findOrphans(entries, SELF_PID);
    const pids = orphans.map((e) => e.pid);
    expect(pids).toEqual([100, 101, 102, 103, 104, 105]);
  });

  test("does not select processes with non-1 PPID", () => {
    const orphans = findOrphans(entries, SELF_PID);
    expect(orphans.find((e) => e.pid === 200)).toBeUndefined();
  });

  test("does not select non-test processes even with PPID 1", () => {
    const orphans = findOrphans(entries, SELF_PID);
    expect(orphans.find((e) => e.pid === 300)).toBeUndefined();
    expect(orphans.find((e) => e.pid === 400)).toBeUndefined();
    expect(orphans.find((e) => e.pid === 500)).toBeUndefined();
  });

  test("excludes own PID", () => {
    const withSelf: PsEntry[] = [{ pid: SELF_PID, ppid: 1, command: "bun test --test-worker" }];
    expect(findOrphans(withSelf, SELF_PID)).toEqual([]);
  });

  test("returns empty for no orphans", () => {
    const clean: PsEntry[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 200, ppid: 50, command: "bun test --test-worker" },
    ];
    expect(findOrphans(clean, SELF_PID)).toEqual([]);
  });
});
