import { afterEach, describe, expect, mock, test } from "bun:test";
import { _restoreOptions, options } from "@mcp-cli/core";
import type { EphemeralDeps } from "./ephemeral";
import { generateEphemeralName, maybeAutoSaveEphemeral } from "./ephemeral";

afterEach(() => {
  _restoreOptions();
});

describe("generateEphemeralName", () => {
  test("produces prefix-hash format", () => {
    const name = generateEphemeralName("server", "get_logs", '{"query":"test"}');
    expect(name).toMatch(/^get_-[0-9a-f]{8}$/);
  });

  test("same inputs produce same name", () => {
    const a = generateEphemeralName("s", "tool", '{"a":1}');
    const b = generateEphemeralName("s", "tool", '{"a":1}');
    expect(a).toBe(b);
  });

  test("different args produce different names", () => {
    const a = generateEphemeralName("s", "tool", '{"a":1}');
    const b = generateEphemeralName("s", "tool", '{"a":2}');
    expect(a).not.toBe(b);
  });

  test("strips non-alphanumeric chars from prefix", () => {
    const name = generateEphemeralName("s", "a/b-c", "{}");
    // "a/b-" → prefix should only have alphanumeric + underscore
    expect(name).toMatch(/^[a-zA-Z0-9_]+-[0-9a-f]{8}$/);
  });
});

describe("maybeAutoSaveEphemeral", () => {
  function createDeps(overrides?: Partial<EphemeralDeps>): EphemeralDeps {
    return {
      ipcCall: mock(() => Promise.resolve({ ok: true, filePath: "/tmp/test.ts" })) as EphemeralDeps["ipcCall"],
      readCliConfig: () => ({}),
      logError: mock(() => {}),
      ...overrides,
    };
  }

  test("does not save when args are below threshold", async () => {
    const deps = createDeps();
    options.EPHEMERAL_ALIAS_CHAR_THRESHOLD = 400;

    await maybeAutoSaveEphemeral("server", "tool", { short: "args" }, deps);

    expect(deps.ipcCall).not.toHaveBeenCalled();
    expect(deps.logError).not.toHaveBeenCalled();
  });

  test("saves when args exceed threshold", async () => {
    const deps = createDeps();
    options.EPHEMERAL_ALIAS_CHAR_THRESHOLD = 10;

    const longArgs = { query: "a".repeat(100) };
    await maybeAutoSaveEphemeral("server", "get_logs", longArgs, deps);

    expect(deps.ipcCall).toHaveBeenCalledTimes(1);
    const callArgs = (deps.ipcCall as ReturnType<typeof mock>).mock.calls[0];
    expect(callArgs[0]).toBe("saveAlias");
    const params = callArgs[1] as Record<string, unknown>;
    expect(params.name).toMatch(/^get_-[0-9a-f]{8}$/);
    expect(params.expiresAt).toBeGreaterThan(Date.now());
    expect(params.description).toBe("ephemeral: server/get_logs");
    expect(deps.logError).toHaveBeenCalledTimes(1);
  });

  test("does not save when feature is disabled via config", async () => {
    const deps = createDeps({
      readCliConfig: () => ({ ephemeralAliases: { enabled: false } }),
    });
    options.EPHEMERAL_ALIAS_CHAR_THRESHOLD = 10;

    await maybeAutoSaveEphemeral("server", "tool", { query: "a".repeat(100) }, deps);

    expect(deps.ipcCall).not.toHaveBeenCalled();
  });

  test("uses config charThreshold override", async () => {
    const deps = createDeps({
      readCliConfig: () => ({ ephemeralAliases: { charThreshold: 5000 } }),
    });
    options.EPHEMERAL_ALIAS_CHAR_THRESHOLD = 10;

    // Args exceed default (10) but not config override (5000)
    await maybeAutoSaveEphemeral("server", "tool", { query: "a".repeat(100) }, deps);

    expect(deps.ipcCall).not.toHaveBeenCalled();
  });

  test("uses config ttlMs override", async () => {
    const deps = createDeps({
      readCliConfig: () => ({ ephemeralAliases: { ttlMs: 60000 } }),
    });
    options.EPHEMERAL_ALIAS_CHAR_THRESHOLD = 10;

    const before = Date.now();
    await maybeAutoSaveEphemeral("server", "tool", { query: "a".repeat(100) }, deps);

    const callArgs = (deps.ipcCall as ReturnType<typeof mock>).mock.calls[0];
    const params = callArgs[1] as Record<string, unknown>;
    const expiresAt = params.expiresAt as number;
    // Should be roughly now + 60000, not the default 48h
    expect(expiresAt).toBeLessThan(before + 120000);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60000);
  });

  test("generates script with correct server/tool references", async () => {
    const deps = createDeps();
    options.EPHEMERAL_ALIAS_CHAR_THRESHOLD = 10;

    await maybeAutoSaveEphemeral("my-server", "my-tool", { query: "a".repeat(100) }, deps);

    const callArgs = (deps.ipcCall as ReturnType<typeof mock>).mock.calls[0];
    const params = callArgs[1] as Record<string, unknown>;
    const script = params.script as string;
    expect(script).toContain('"my-server"');
    expect(script).toContain('"my-tool"');
    expect(script).toContain("mcp[");
  });

  test("hint message includes alias name", async () => {
    const deps = createDeps();
    options.EPHEMERAL_ALIAS_CHAR_THRESHOLD = 10;

    await maybeAutoSaveEphemeral("server", "get_logs", { query: "a".repeat(100) }, deps);

    const logCall = (deps.logError as ReturnType<typeof mock>).mock.calls[0];
    const msg = logCall[0] as string;
    expect(msg).toContain("mcx run");
    expect(msg).toContain("mcx alias edit");
  });

  // #2983: the hint promises `mcx run <name>` works — it must never be printed
  // for an alias the daemon did not persist.
  test("does not print the run hint when saveAlias rejects", async () => {
    const deps = createDeps({
      ipcCall: mock(() => Promise.reject(new Error("daemon unavailable"))) as EphemeralDeps["ipcCall"],
    });
    options.EPHEMERAL_ALIAS_CHAR_THRESHOLD = 10;

    await maybeAutoSaveEphemeral("server", "get_logs", { query: "a".repeat(100) }, deps);

    const messages = (deps.logError as ReturnType<typeof mock>).mock.calls.map((c) => c[0] as string);
    expect(messages.some((m) => m.includes("mcx run"))).toBe(false);
    expect(messages.some((m) => m.includes("daemon unavailable"))).toBe(true);
  });

  test("does not print the run hint when saveAlias reports ok: false", async () => {
    const deps = createDeps({
      ipcCall: mock(() => Promise.resolve({ ok: false, reason: "permanent_alias_exists" })) as EphemeralDeps["ipcCall"],
    });
    options.EPHEMERAL_ALIAS_CHAR_THRESHOLD = 10;

    await maybeAutoSaveEphemeral("server", "get_logs", { query: "a".repeat(100) }, deps);

    const messages = (deps.logError as ReturnType<typeof mock>).mock.calls.map((c) => c[0] as string);
    expect(messages.some((m) => m.includes("mcx run"))).toBe(false);
    expect(messages.some((m) => m.includes("was not saved"))).toBe(true);
  });

  test("prints the run hint only after the save resolves", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = createDeps({
      ipcCall: mock(async () => {
        order.push("save-start");
        await gate;
        order.push("save-done");
        return { ok: true, filePath: "/tmp/test.ts" };
      }) as EphemeralDeps["ipcCall"],
      logError: mock((msg: string) => {
        order.push(`log:${msg.includes("mcx run") ? "hint" : "other"}`);
      }),
    });
    options.EPHEMERAL_ALIAS_CHAR_THRESHOLD = 10;

    const pending = maybeAutoSaveEphemeral("server", "get_logs", { query: "a".repeat(100) }, deps);
    expect(order).toEqual(["save-start"]);

    release?.();
    await pending;

    expect(order).toEqual(["save-start", "save-done", "log:hint"]);
  });
});
