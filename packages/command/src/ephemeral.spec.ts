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
    expect(name).toMatch(/^get_-[0-9a-f]{4}$/);
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
    expect(name).toMatch(/^[a-zA-Z0-9_]+-[0-9a-f]{4}$/);
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

  test("does not save when args are below threshold", () => {
    const deps = createDeps();
    options.EPHEMERAL_ALIAS_CHAR_THRESHOLD = 400;

    maybeAutoSaveEphemeral("server", "tool", { short: "args" }, deps);

    expect(deps.ipcCall).not.toHaveBeenCalled();
    expect(deps.logError).not.toHaveBeenCalled();
  });

  test("saves when args exceed threshold", () => {
    const deps = createDeps();
    options.EPHEMERAL_ALIAS_CHAR_THRESHOLD = 10;

    const longArgs = { query: "a".repeat(100) };
    maybeAutoSaveEphemeral("server", "get_logs", longArgs, deps);

    expect(deps.ipcCall).toHaveBeenCalledTimes(1);
    const callArgs = (deps.ipcCall as ReturnType<typeof mock>).mock.calls[0];
    expect(callArgs[0]).toBe("saveAlias");
    const params = callArgs[1] as Record<string, unknown>;
    expect(params.name).toMatch(/^get_-[0-9a-f]{4}$/);
    expect(params.expiresAt).toBeGreaterThan(Date.now());
    expect(params.description).toBe("ephemeral: server/get_logs");
    expect(deps.logError).toHaveBeenCalledTimes(1);
  });

  test("does not save when feature is disabled via config", () => {
    const deps = createDeps({
      readCliConfig: () => ({ ephemeralAliases: { enabled: false } }),
    });
    options.EPHEMERAL_ALIAS_CHAR_THRESHOLD = 10;

    maybeAutoSaveEphemeral("server", "tool", { query: "a".repeat(100) }, deps);

    expect(deps.ipcCall).not.toHaveBeenCalled();
  });

  test("uses config charThreshold override", () => {
    const deps = createDeps({
      readCliConfig: () => ({ ephemeralAliases: { charThreshold: 5000 } }),
    });
    options.EPHEMERAL_ALIAS_CHAR_THRESHOLD = 10;

    // Args exceed default (10) but not config override (5000)
    maybeAutoSaveEphemeral("server", "tool", { query: "a".repeat(100) }, deps);

    expect(deps.ipcCall).not.toHaveBeenCalled();
  });

  test("uses config ttlMs override", () => {
    const deps = createDeps({
      readCliConfig: () => ({ ephemeralAliases: { ttlMs: 60000 } }),
    });
    options.EPHEMERAL_ALIAS_CHAR_THRESHOLD = 10;

    const before = Date.now();
    maybeAutoSaveEphemeral("server", "tool", { query: "a".repeat(100) }, deps);

    const callArgs = (deps.ipcCall as ReturnType<typeof mock>).mock.calls[0];
    const params = callArgs[1] as Record<string, unknown>;
    const expiresAt = params.expiresAt as number;
    // Should be roughly now + 60000, not the default 48h
    expect(expiresAt).toBeLessThan(before + 120000);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60000);
  });

  test("generates script with correct server/tool references", () => {
    const deps = createDeps();
    options.EPHEMERAL_ALIAS_CHAR_THRESHOLD = 10;

    maybeAutoSaveEphemeral("my-server", "my-tool", { query: "a".repeat(100) }, deps);

    const callArgs = (deps.ipcCall as ReturnType<typeof mock>).mock.calls[0];
    const params = callArgs[1] as Record<string, unknown>;
    const script = params.script as string;
    expect(script).toContain('"my-server"');
    expect(script).toContain('"my-tool"');
    expect(script).toContain("mcp[");
  });

  test("hint message includes alias name", () => {
    const deps = createDeps();
    options.EPHEMERAL_ALIAS_CHAR_THRESHOLD = 10;

    maybeAutoSaveEphemeral("server", "get_logs", { query: "a".repeat(100) }, deps);

    const logCall = (deps.logError as ReturnType<typeof mock>).mock.calls[0];
    const msg = logCall[0] as string;
    expect(msg).toContain("mcx run");
    expect(msg).toContain("mcx alias edit");
  });
});
