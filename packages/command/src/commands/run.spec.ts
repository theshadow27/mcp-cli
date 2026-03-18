import { afterEach, describe, expect, mock, test } from "bun:test";
import { _restoreOptions, options } from "@mcp-cli/core";
import type { CmdRunDeps } from "./run";
import { cmdRun, parseRunArgs } from "./run";

describe("parseRunArgs", () => {
  test("parses --key value pairs", () => {
    expect(parseRunArgs(["--name", "alice", "--age", "30"])).toEqual({
      jsonInput: undefined,
      cliArgs: { name: "alice", age: "30" },
    });
  });

  test("returns empty for no args", () => {
    expect(parseRunArgs([])).toEqual({ jsonInput: undefined, cliArgs: {} });
  });

  test("ignores flags without a following value", () => {
    expect(parseRunArgs(["--orphan"])).toEqual({ jsonInput: undefined, cliArgs: {} });
  });

  test("captures first positional arg as jsonInput", () => {
    expect(parseRunArgs(['{"email":"a@b.com"}', "--key", "val"])).toEqual({
      jsonInput: '{"email":"a@b.com"}',
      cliArgs: { key: "val" },
    });
  });

  test("captures plain string as jsonInput", () => {
    expect(parseRunArgs(['"hello"'])).toEqual({
      jsonInput: '"hello"',
      cliArgs: {},
    });
  });

  test("last value wins for duplicate keys", () => {
    expect(parseRunArgs(["--k", "first", "--k", "second"])).toEqual({
      jsonInput: undefined,
      cliArgs: { k: "second" },
    });
  });

  test("handles values that look like flags", () => {
    expect(parseRunArgs(["--flag", "--other"])).toEqual({
      jsonInput: undefined,
      cliArgs: { flag: "--other" },
    });
  });

  test("json input and flags together", () => {
    expect(parseRunArgs(['{"q":"test"}', "--verbose", "true"])).toEqual({
      jsonInput: '{"q":"test"}',
      cliArgs: { verbose: "true" },
    });
  });
});

describe("cmdRun promotion hint", () => {
  afterEach(() => {
    _restoreOptions();
  });

  function createDeps(overrides?: Partial<CmdRunDeps>): CmdRunDeps {
    const ipcResponses: Record<string, unknown> = {
      getAlias: {
        name: "test-alias",
        description: "ephemeral: server/tool",
        filePath: "/tmp/test.ts",
        aliasType: "freeform",
        expiresAt: Date.now() + 86400000,
        script: "// test",
        runCount: 0,
        lastRunAt: null,
      },
      touchAlias: { ok: true },
      recordAliasRun: { ok: true, runCount: 3 },
    };

    return {
      ipcCall: mock(((method: string) => Promise.resolve(ipcResponses[method])) as CmdRunDeps["ipcCall"]),
      readCliConfig: () => ({}),
      runAlias: mock(() => Promise.resolve()) as unknown as CmdRunDeps["runAlias"],
      printError: mock(() => {}) as unknown as CmdRunDeps["printError"],
      logError: mock(() => {}),
      exit: mock(() => {
        throw new Error("exit called");
      }) as unknown as CmdRunDeps["exit"],
      ...overrides,
    };
  }

  test("emits promotion hint when run count equals threshold", async () => {
    options.EPHEMERAL_ALIAS_PROMOTION_THRESHOLD = 3;
    const deps = createDeps();

    await cmdRun(["test-alias"], deps);

    // Wait for fire-and-forget promise to resolve
    await new Promise((r) => setTimeout(r, 10));
    const logCalls = (deps.logError as ReturnType<typeof mock>).mock.calls;
    const promotionMsg = logCalls.find((c: unknown[]) => (c[0] as string).includes("promote"));
    expect(promotionMsg).toBeDefined();
    expect((promotionMsg as unknown[])[0]).toContain("mcx alias promote test-alias");
  });

  test("does not emit promotion hint below threshold", async () => {
    options.EPHEMERAL_ALIAS_PROMOTION_THRESHOLD = 5;
    const deps = createDeps();

    await cmdRun(["test-alias"], deps);
    await new Promise((r) => setTimeout(r, 10));

    const logCalls = (deps.logError as ReturnType<typeof mock>).mock.calls;
    const promotionMsg = logCalls.find((c: unknown[]) => (c[0] as string).includes("promote"));
    expect(promotionMsg).toBeUndefined();
  });

  test("does not emit promotion hint for permanent aliases", async () => {
    options.EPHEMERAL_ALIAS_PROMOTION_THRESHOLD = 3;
    const deps = createDeps({
      ipcCall: mock(((method: string) => {
        if (method === "getAlias") {
          return Promise.resolve({
            name: "perm",
            description: "permanent",
            filePath: "/tmp/perm.ts",
            aliasType: "freeform",
            expiresAt: null,
            script: "// perm",
            runCount: 0,
            lastRunAt: null,
          });
        }
        if (method === "recordAliasRun") return Promise.resolve({ ok: true, runCount: 3 });
        return Promise.resolve({ ok: true });
      }) as CmdRunDeps["ipcCall"]),
    });

    await cmdRun(["perm"], deps);
    await new Promise((r) => setTimeout(r, 10));

    const logCalls = (deps.logError as ReturnType<typeof mock>).mock.calls;
    const promotionMsg = logCalls.find((c: unknown[]) => (c[0] as string).includes("promote"));
    expect(promotionMsg).toBeUndefined();
  });

  test("uses config promotionThreshold override", async () => {
    options.EPHEMERAL_ALIAS_PROMOTION_THRESHOLD = 3;
    const deps = createDeps({
      readCliConfig: () => ({ ephemeralAliases: { promotionThreshold: 5 } }),
    });

    await cmdRun(["test-alias"], deps);
    await new Promise((r) => setTimeout(r, 10));

    // runCount=3 but threshold=5, so no hint
    const logCalls = (deps.logError as ReturnType<typeof mock>).mock.calls;
    const promotionMsg = logCalls.find((c: unknown[]) => (c[0] as string).includes("promote"));
    expect(promotionMsg).toBeUndefined();
  });
});
