import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLockfile } from "@mcp-cli/core";
import { checkStateSubset, cmdPhase, resolvePhaseSource } from "./phase";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcx-phase-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolvePhaseSource", () => {
  test("resolves relative paths against repo root", () => {
    expect(resolvePhaseSource("./foo.ts", "/repo")).toBe("/repo/foo.ts");
  });

  test("resolves bare relative paths against repo root", () => {
    expect(resolvePhaseSource("scripts/foo.ts", "/repo")).toBe("/repo/scripts/foo.ts");
  });

  test("passes absolute paths through", () => {
    expect(resolvePhaseSource("/abs/path.ts", "/repo")).toBe("/abs/path.ts");
  });

  test("handles file:// URIs", () => {
    expect(resolvePhaseSource("file:///abs/path.ts", "/repo")).toBe("/abs/path.ts");
  });

  test("rejects remote `scheme://` URIs", () => {
    expect(() => resolvePhaseSource("https://example.com/x.ts", "/repo")).toThrow(/remote sources/);
    expect(() => resolvePhaseSource("github://owner/repo/path.ts", "/repo")).toThrow(/remote sources/);
  });
});

describe("checkStateSubset", () => {
  test("empty phase state is always a subset", () => {
    expect(checkStateSubset("p", undefined, { foo: "string" })).toEqual([]);
    expect(checkStateSubset("p", {}, { foo: "string" })).toEqual([]);
  });

  test("phase key not in manifest state is an error", () => {
    const errs = checkStateSubset("p", { extra: {} }, { foo: "string" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('phase "p"');
    expect(errs[0]).toContain('"extra"');
  });

  test("phase is subset of manifest state", () => {
    expect(checkStateSubset("p", { foo: {} }, { foo: "string", bar: "number" })).toEqual([]);
  });
});

const simpleAlias = `
import { defineAlias, z } from "mcp-cli";

defineAlias(({ z }) => ({
  name: "implement",
  description: "Implement phase",
  input: z.object({ issue: z.number() }),
  output: z.object({ pr: z.number() }),
  fn: async (input) => ({ pr: input.issue + 1 }),
}));
`.trim();

const simpleManifest = `
initial: implement
phases:
  implement:
    source: ./impl.ts
    next: []
`.trim();

describe("cmdPhase install — integration", () => {
  test("writes .mcx.lock after resolving sources", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    writeFileSync(join(dir, "impl.ts"), simpleAlias);

    const logs: string[] = [];
    const errs: string[] = [];
    await cmdPhase(["install"], {
      cwd: () => dir,
      log: (m) => logs.push(m),
      logError: (m) => errs.push(m),
      exit: ((code: number) => {
        throw new Error(`exit(${code})`);
      }) as (code: number) => never,
    });

    const lockPath = join(dir, ".mcx.lock");
    expect(existsSync(lockPath)).toBe(true);

    const lock = parseLockfile(readFileSync(lockPath, "utf-8"));
    expect(lock.version).toBe(1);
    expect(lock.phases).toHaveLength(1);
    expect(lock.phases[0].name).toBe("implement");
    expect(lock.phases[0].resolvedPath).toBe("impl.ts");
    expect(lock.phases[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(lock.phases[0].schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(logs.some((l) => l.includes("Installed 1 phase"))).toBe(true);
  }, 15_000);

  test("errors when no manifest present", async () => {
    const errs: string[] = [];
    let exitCode: number | undefined;
    await cmdPhase(["install"], {
      cwd: () => dir,
      log: () => {},
      logError: (m) => errs.push(m),
      exit: ((code: number) => {
        exitCode = code;
        throw new Error("exit");
      }) as (code: number) => never,
    }).catch(() => {});

    expect(exitCode).toBe(1);
    expect(errs.some((e) => e.includes("no .mcx.yaml or .mcx.json"))).toBe(true);
  });

  test("errors when source not found", async () => {
    writeFileSync(join(dir, ".mcx.yaml"), simpleManifest);
    // impl.ts missing

    const errs: string[] = [];
    let exitCode: number | undefined;
    await cmdPhase(["install"], {
      cwd: () => dir,
      log: () => {},
      logError: (m) => errs.push(m),
      exit: ((code: number) => {
        exitCode = code;
        throw new Error("exit");
      }) as (code: number) => never,
    }).catch(() => {});

    expect(exitCode).toBe(1);
    const joined = errs.join("\n");
    expect(joined).toContain('phase "implement"');
    expect(joined).toContain("not found");
  });
});
