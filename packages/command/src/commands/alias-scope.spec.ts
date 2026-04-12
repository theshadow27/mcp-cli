/**
 * Tests for `--scope` flag parsing on `mcx alias save` and the scope cwd
 * enforcement in `mcx alias run` (issue #1289).
 */

import { describe, expect, mock, test } from "bun:test";
import { parseScopeFlag } from "./alias";
import { type CmdRunDeps, cmdRun, isScopeAllowed } from "./run";

describe("parseScopeFlag", () => {
  test("defaults to global when --scope is not passed", () => {
    const { scope, scopeDefaulted, rest } = parseScopeFlag(["save", "name", "@file.ts"]);
    expect(scope).toBe("global");
    expect(scopeDefaulted).toBe(true);
    expect(rest).toEqual(["save", "name", "@file.ts"]);
  });

  test("--scope global is explicit", () => {
    const { scope, scopeDefaulted } = parseScopeFlag(["save", "--scope", "global", "n"]);
    expect(scope).toBe("global");
    expect(scopeDefaulted).toBe(false);
  });

  test("--scope null sets scope to null (legacy dispatch)", () => {
    const { scope } = parseScopeFlag(["save", "--scope", "null", "n"]);
    expect(scope).toBeNull();
  });

  test("--scope legacy is an alias for null", () => {
    const { scope } = parseScopeFlag(["save", "--scope", "legacy", "n"]);
    expect(scope).toBeNull();
  });

  test("--scope <path> resolves to absolute path", () => {
    const { scope } = parseScopeFlag(["save", "--scope", "/absolute/path", "n"]);
    expect(scope).toBe("/absolute/path");
  });

  test("--scope . resolves to provided cwd", () => {
    const { scope } = parseScopeFlag(["save", "--scope", ".", "n"], "/workspace/repo");
    expect(scope).toBe("/workspace/repo");
  });

  test("--scope=global equals --scope global", () => {
    const { scope, rest } = parseScopeFlag(["save", "--scope=global", "n"]);
    expect(scope).toBe("global");
    expect(rest).toEqual(["save", "n"]);
  });

  test("strips --scope from rest", () => {
    const { rest } = parseScopeFlag(["save", "--scope", "global", "name", "src"]);
    expect(rest).toEqual(["save", "name", "src"]);
  });

  test("--scope as the last argument throws (no silent swallow)", () => {
    expect(() => parseScopeFlag(["save", "name", "--scope"])).toThrow(/--scope requires a value/);
  });

  test("--scope with empty string is rejected", () => {
    expect(() => parseScopeFlag(["save", "--scope", "", "n"])).toThrow(/--scope value cannot be empty/);
    expect(() => parseScopeFlag(["save", "--scope=", "n"])).toThrow(/--scope value cannot be empty/);
  });

  test("--scope containing a null byte is rejected", () => {
    expect(() => parseScopeFlag(["save", "--scope", "/tmp/\0bad", "n"])).toThrow(/invalid/);
  });
});

describe("isScopeAllowed", () => {
  test("null scope is allowed from any cwd (legacy)", () => {
    expect(isScopeAllowed(null, "/anywhere")).toBe(true);
    expect(isScopeAllowed(undefined, "/anywhere")).toBe(true);
  });

  test("global scope is allowed from any cwd", () => {
    expect(isScopeAllowed("global", "/anywhere")).toBe(true);
  });

  test("path scope is allowed when cwd equals the path", () => {
    expect(isScopeAllowed("/workspace/repo", "/workspace/repo")).toBe(true);
  });

  test("path scope is allowed when cwd is inside the path", () => {
    expect(isScopeAllowed("/workspace/repo", "/workspace/repo/sub/dir")).toBe(true);
  });

  test("path scope is rejected for sibling paths with matching prefix", () => {
    // /workspace/repo should NOT match /workspace/repository
    expect(isScopeAllowed("/workspace/repo", "/workspace/repository")).toBe(false);
  });

  test("path scope is rejected from an outside cwd", () => {
    expect(isScopeAllowed("/workspace/repo", "/elsewhere")).toBe(false);
  });

  test("non-absolute scope strings fail closed (never grant access)", () => {
    // A malformed scope that isn't null/global/absolute must NOT silently grant
    // access — see adversarial review #3 (fail-closed boundary).
    expect(isScopeAllowed("dev", "/anywhere")).toBe(false);
    expect(isScopeAllowed("./proj", "/anywhere")).toBe(false);
    expect(isScopeAllowed("", "/anywhere")).toBe(false);
  });

  test("cwd with .. segments is normalized before comparison", () => {
    // /workspace/repo/../sibling normalizes to /workspace/sibling, which is NOT
    // inside /workspace/repo — must be rejected.
    expect(isScopeAllowed("/workspace/repo", "/workspace/repo/../sibling")).toBe(false);
  });
});

describe("cmdRun scope enforcement", () => {
  function makeRunDeps(
    aliasScope: string | null | undefined,
    cwd: string,
    exitImpl?: (code: number) => never,
  ): CmdRunDeps {
    const ipcResponses: Record<string, unknown> = {
      getAlias: {
        name: "scoped",
        description: "d",
        filePath: "/tmp/scoped.ts",
        aliasType: "defineAlias",
        script: "// test",
        runCount: 0,
        lastRunAt: null,
        scope: aliasScope ?? null,
      },
      touchAlias: { ok: true },
      recordAliasRun: { ok: true, runCount: 1 },
    };

    return {
      ipcCall: mock(((method: string) => Promise.resolve(ipcResponses[method])) as CmdRunDeps["ipcCall"]),
      readCliConfig: () => ({}),
      runAlias: mock(() => Promise.resolve()) as unknown as CmdRunDeps["runAlias"],
      printError: mock(() => {}) as unknown as CmdRunDeps["printError"],
      logError: mock(() => {}),
      exit:
        (exitImpl as CmdRunDeps["exit"]) ??
        (mock(() => {
          throw new Error("exit called");
        }) as unknown as CmdRunDeps["exit"]),
      cwd: mock(() => cwd),
    };
  }

  test("runs null-scoped alias from any cwd", async () => {
    const deps = makeRunDeps(null, "/elsewhere");
    const { _recordPromise } = await cmdRun(["scoped"], deps);
    await _recordPromise;
    expect(deps.runAlias).toHaveBeenCalled();
  });

  test("runs global-scoped alias from any cwd", async () => {
    const deps = makeRunDeps("global", "/elsewhere");
    const { _recordPromise } = await cmdRun(["scoped"], deps);
    await _recordPromise;
    expect(deps.runAlias).toHaveBeenCalled();
  });

  test("runs path-scoped alias when cwd is inside the scope", async () => {
    const deps = makeRunDeps("/workspace/repo", "/workspace/repo/src");
    const { _recordPromise } = await cmdRun(["scoped"], deps);
    await _recordPromise;
    expect(deps.runAlias).toHaveBeenCalled();
  });

  test("rejects path-scoped alias when cwd is outside", async () => {
    const exit = mock(() => {
      throw new Error("exit");
    });
    const deps = makeRunDeps("/workspace/repo", "/elsewhere", exit as unknown as CmdRunDeps["exit"]);
    await expect(cmdRun(["scoped"], deps)).rejects.toThrow("exit");
    expect(deps.runAlias).not.toHaveBeenCalled();
    expect(deps.printError).toHaveBeenCalled();
  });
});
