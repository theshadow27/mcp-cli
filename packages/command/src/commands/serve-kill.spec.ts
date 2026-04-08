import { describe, expect, test } from "bun:test";
import type { IpcMethod, IpcMethodResult } from "@mcp-cli/core";
import { type ServeKillDeps, cmdServeKill } from "./serve-kill";

function makeDeps(overrides?: Partial<ServeKillDeps>): ServeKillDeps & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    ipcCall: overrides?.ipcCall ?? (async <M extends IpcMethod>() => ({ killed: 0 }) as IpcMethodResult[M]),
    log: (msg) => logs.push(msg),
    logError: (msg) => errors.push(msg),
    ...overrides,
  };
}

describe("cmdServeKill", () => {
  test("prints help with --help", async () => {
    const deps = makeDeps();
    await cmdServeKill(["--help"], deps);
    expect(deps.logs.join("\n")).toContain("mcx serve kill");
  });

  test("prints help when no args provided", async () => {
    const deps = makeDeps();
    await cmdServeKill([], deps);
    expect(deps.errors.join("\n")).toContain("mcx serve kill");
  });

  test("kills by PID", async () => {
    let calledWith: unknown;
    const deps = makeDeps({
      ipcCall: async <M extends IpcMethod>(_method: M, params?: unknown) => {
        calledWith = params;
        return { killed: 1 } as IpcMethodResult[M];
      },
    });
    await cmdServeKill(["1234"], deps);
    expect(calledWith).toEqual({ pid: 1234 });
    expect(deps.errors[0]).toContain("Killed 1");
  });

  test("kills all with --all", async () => {
    let calledWith: unknown;
    const deps = makeDeps({
      ipcCall: async <M extends IpcMethod>(_method: M, params?: unknown) => {
        calledWith = params;
        return { killed: 3 } as IpcMethodResult[M];
      },
    });
    await cmdServeKill(["--all"], deps);
    expect(calledWith).toEqual({ all: true });
    expect(deps.errors[0]).toContain("Killed 3");
  });

  test("reports zero kills", async () => {
    const deps = makeDeps({
      ipcCall: async <M extends IpcMethod>() => ({ killed: 0 }) as IpcMethodResult[M],
    });
    await cmdServeKill(["--all"], deps);
    expect(deps.errors[0]).toContain("No serve instances");
  });

  test("outputs JSON with --json", async () => {
    const deps = makeDeps({
      ipcCall: async <M extends IpcMethod>() => ({ killed: 2 }) as IpcMethodResult[M],
    });
    await cmdServeKill(["--all", "--json"], deps);
    expect(JSON.parse(deps.logs[0])).toEqual({ killed: 2 });
  });

  test("rejects invalid PID", async () => {
    const deps = makeDeps();
    await cmdServeKill(["abc"], deps);
    expect(deps.errors[0]).toContain("Invalid PID");
  });
});
