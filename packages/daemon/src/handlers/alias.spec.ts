import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMethod } from "@mcp-cli/core";
import type { RequestHandler } from "../handler-types";
import { AliasHandlers } from "./alias";

function invoke(map: Map<IpcMethod, RequestHandler>, method: IpcMethod): RequestHandler {
  const h = map.get(method);
  if (!h) throw new Error(`Handler "${method}" not registered`);
  return h;
}

function makeTmpDir(): string {
  const dir = join(tmpdir(), `alias-spec-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mockDb(overrides: Record<string, unknown> = {}) {
  const aliases = new Map<
    string,
    {
      name: string;
      filePath: string;
      aliasType: string;
      expiresAt: null | number;
      runCount: number;
      lastRunAt: null;
      scope: null;
      description: string;
    }
  >();
  return {
    listAliases: () => [...aliases.values()],
    getAlias: (name: string) => aliases.get(name) ?? undefined,
    saveAlias: (name: string, filePath: string, description?: string, aliasType?: string, ...rest: unknown[]) => {
      aliases.set(name, {
        name,
        filePath,
        description: description ?? "",
        aliasType: aliasType ?? "freeform",
        expiresAt: null,
        runCount: 0,
        lastRunAt: null,
        scope: null,
      });
    },
    deleteAlias: (name: string) => {
      aliases.delete(name);
    },
    touchAliasExpiry: () => {},
    recordAliasRun: (name: string) => {
      const a = aliases.get(name);
      if (a) a.runCount += 1;
      return a?.runCount ?? 1;
    },
    ...overrides,
  } as never;
}

function mockAliasServer(overrides: Record<string, unknown> = {}) {
  return {
    refresh: async () => {},
    validateInSubprocess: async () => ({
      valid: true,
      errors: [],
      warnings: [],
      description: undefined,
      inputSchema: undefined,
      outputSchema: undefined,
      monitorDefs: undefined,
    }),
    extractMonitorsInSubprocess: async () => [],
    callToolWithChain: async () => ({ content: [] }),
    ...overrides,
  } as never;
}

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

function buildHandlers(
  db = mockDb(),
  aliasServer = mockAliasServer(),
  onAliasChanged?: (name: string) => void,
): Map<IpcMethod, RequestHandler> {
  const map = new Map<IpcMethod, RequestHandler>();
  new AliasHandlers(db, aliasServer, mockLogger, onAliasChanged).register(map);
  return map;
}

describe("AliasHandlers – listAliases", () => {
  test("returns db result", async () => {
    const aliases = [
      {
        name: "foo",
        description: "bar",
        filePath: "/tmp/foo.ts",
        aliasType: "freeform",
        expiresAt: null,
        runCount: 0,
        lastRunAt: null,
        scope: null,
      },
    ];
    const map = buildHandlers(mockDb({ listAliases: () => aliases }));
    const result = await invoke(map, "listAliases")(undefined, {} as never);
    expect(result).toEqual(aliases);
  });
});

describe("AliasHandlers – getAlias", () => {
  test("returns null for missing alias", async () => {
    const map = buildHandlers(mockDb({ getAlias: () => undefined }));
    const result = await invoke(map, "getAlias")({ name: "missing" }, {} as never);
    expect(result).toBeNull();
  });

  test("reads script from file and returns alias with script", async () => {
    const tmpDir = makeTmpDir();
    try {
      const filePath = join(tmpDir, "hello.ts");
      writeFileSync(filePath, 'console.log("hello")', "utf-8");
      const map = buildHandlers(
        mockDb({
          getAlias: () => ({
            name: "hello",
            filePath,
            description: "test",
            aliasType: "freeform",
            expiresAt: null,
            runCount: 0,
            lastRunAt: null,
            scope: null,
          }),
        }),
      );
      const result = (await invoke(map, "getAlias")({ name: "hello" }, {} as never)) as { script: string };
      expect(result.script).toBe('console.log("hello")');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns empty script when file is gone", async () => {
    const map = buildHandlers(
      mockDb({
        getAlias: () => ({
          name: "gone",
          filePath: "/nonexistent/path/gone.ts",
          description: "",
          aliasType: "freeform",
          expiresAt: null,
          runCount: 0,
          lastRunAt: null,
          scope: null,
        }),
      }),
    );
    const result = (await invoke(map, "getAlias")({ name: "gone" }, {} as never)) as { script: string };
    expect(result.script).toBe("");
  });
});

describe("AliasHandlers – saveAlias (core path)", () => {
  test("freeform script creates file and saves to db", async () => {
    // We can't easily test the full bundleAlias path in a unit test,
    // but we can verify the handler returns ok and triggers the alias server refresh.
    // saveAlias will throw when bundleAlias fails, but the catch branch saves without bundle.
    let savedName: string | undefined;
    let refreshCalled = false;
    const db = mockDb({
      getAlias: () => undefined,
      saveAlias: (name: string) => {
        savedName = name;
      },
    });
    const as = mockAliasServer({
      refresh: async () => {
        refreshCalled = true;
      },
    });

    // We test the error/fallback path since bundleAlias requires a real file on disk.
    // The handler catches bundle failures and still calls saveAlias.
    const map = buildHandlers(db, as);
    const result = (await invoke(map, "saveAlias")(
      { name: "myscript", script: 'console.log("hi")', description: "test" },
      {} as never,
    )) as { ok: boolean; validationErrors?: string[] };

    // Either succeeds or falls into bundle-failed path — either way ok:true
    expect(result.ok).toBe(true);
    expect(savedName).toBe("myscript");
    expect(refreshCalled).toBe(true);
  });

  test("refuses to overwrite permanent alias with ephemeral one", async () => {
    const db = mockDb({
      getAlias: () => ({
        name: "permanent",
        filePath: "/tmp/permanent.ts",
        description: "",
        aliasType: "freeform",
        expiresAt: null, // null = permanent
        runCount: 0,
        lastRunAt: null,
        scope: null,
      }),
    });
    const map = buildHandlers(db);
    const result = (await invoke(map, "saveAlias")(
      { name: "permanent", script: 'console.log("x")', description: "", expiresAt: Date.now() + 60_000 },
      {} as never,
    )) as { ok: boolean; reason?: string };
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("permanent_alias_exists");
  });
});

describe("AliasHandlers – deleteAlias", () => {
  test("removes file from db and refreshes alias server", async () => {
    let deletedName: string | undefined;
    let refreshCalled = false;
    const db = mockDb({
      getAlias: () => ({
        name: "todel",
        filePath: "/nonexistent/todel.ts",
        description: "",
        aliasType: "freeform",
        expiresAt: null,
        runCount: 0,
        lastRunAt: null,
        scope: null,
      }),
      deleteAlias: (name: string) => {
        deletedName = name;
      },
    });
    const as = mockAliasServer({
      refresh: async () => {
        refreshCalled = true;
      },
    });
    const map = buildHandlers(db, as);
    const result = (await invoke(map, "deleteAlias")({ name: "todel" }, {} as never)) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(deletedName).toBe("todel");
    expect(refreshCalled).toBe(true);
  });

  test("returns ok even when alias does not exist", async () => {
    const map = buildHandlers(mockDb({ getAlias: () => undefined }));
    const result = (await invoke(map, "deleteAlias")({ name: "noop" }, {} as never)) as { ok: boolean };
    expect(result.ok).toBe(true);
  });
});

describe("AliasHandlers – touchAlias", () => {
  test("calls db.touchAliasExpiry and returns ok", async () => {
    let touchedName: string | undefined;
    let touchedExpiry: number | undefined;
    const db = mockDb({
      touchAliasExpiry: (name: string, expiresAt: number) => {
        touchedName = name;
        touchedExpiry = expiresAt;
      },
    });
    const map = buildHandlers(db);
    const expiry = Date.now() + 3600_000;
    const result = (await invoke(map, "touchAlias")({ name: "myalias", expiresAt: expiry }, {} as never)) as {
      ok: boolean;
    };
    expect(result.ok).toBe(true);
    expect(touchedName).toBe("myalias");
    expect(touchedExpiry).toBe(expiry);
  });
});

describe("AliasHandlers – recordAliasRun", () => {
  test("increments run count and returns it", async () => {
    const db = mockDb({ recordAliasRun: () => 5 });
    const map = buildHandlers(db);
    const result = (await invoke(map, "recordAliasRun")({ name: "myalias" }, {} as never)) as {
      ok: boolean;
      runCount: number;
    };
    expect(result.ok).toBe(true);
    expect(result.runCount).toBe(5);
  });
});

describe("AliasHandlers – checkAlias", () => {
  test("returns valid=false for missing alias", async () => {
    const map = buildHandlers(mockDb({ getAlias: () => undefined }));
    const result = (await invoke(map, "checkAlias")({ name: "nope" }, {} as never)) as {
      valid: boolean;
      aliasType: string;
      errors: string[];
      warnings: string[];
    };
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("not found");
  });
});
