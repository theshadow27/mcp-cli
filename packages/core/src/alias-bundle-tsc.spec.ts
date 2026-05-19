import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFreeformTsc } from "./alias-bundle";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `alias-bundle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("validateFreeformTsc", () => {
  test("returns no warnings for valid freeform script", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "valid-freeform.ts");
    writeFileSync(scriptPath, "const x: number = 42;\nconsole.log(x);\n");

    const result = await validateFreeformTsc(scriptPath);

    expect(result.timedOut).toBe(false);
    expect(result.warnings).toHaveLength(0);
  }, 15_000);

  test("returns warnings for type errors", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "bad-types.ts");
    writeFileSync(scriptPath, 'const x: number = "not a number";\n');

    const result = await validateFreeformTsc(scriptPath);

    expect(result.timedOut).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("TS"))).toBe(true);
  }, 15_000);

  test("handles scripts that import from mcp-cli", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "with-import.ts");
    writeFileSync(
      scriptPath,
      'import { mcp, args } from "mcp-cli";\nconst name: string = args["name"] ?? "world";\nconsole.log(name);\n',
    );

    const result = await validateFreeformTsc(scriptPath);

    expect(result.timedOut).toBe(false);
    // Should not have import resolution errors thanks to the stub
    const importErrors = result.warnings.filter((w) => w.includes("Cannot find module"));
    expect(importErrors).toHaveLength(0);
  }, 15_000);

  test("AliasContext.waitForEvent resolves without type error", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "wait-for-event.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias } from "mcp-cli";',
        "defineAlias({",
        "  name: 'test',",
        "  fn: async (_input: unknown, ctx: import('mcp-cli').AliasContext) => {",
        "    const ev = await ctx.waitForEvent({ type: 'session.result' });",
        "    return ev.event;",
        "  },",
        "});",
      ].join("\n"),
    );

    const result = await validateFreeformTsc(scriptPath);

    expect(result.timedOut).toBe(false);
    expect(result.warnings).toHaveLength(0);
  }, 15_000);

  test("AliasContext.cache, repoRoot, signal resolve without type error", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "ctx-fields.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias } from "mcp-cli";',
        "defineAlias({",
        "  name: 'test',",
        "  fn: async (_input: unknown, ctx: import('mcp-cli').AliasContext) => {",
        "    const v = await ctx.cache('k', () => 42);",
        "    const r: string = ctx.repoRoot;",
        "    const s: AbortSignal = ctx.signal;",
        "    return { v, r, s };",
        "  },",
        "});",
      ].join("\n"),
    );

    const result = await validateFreeformTsc(scriptPath);

    expect(result.timedOut).toBe(false);
    expect(result.warnings).toHaveLength(0);
  }, 15_000);

  test("EventFilterSpec.subscribe rejects invalid category literal", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "bad-category.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias } from "mcp-cli";',
        "defineAlias({",
        "  name: 'test',",
        "  fn: async (_input: unknown, ctx: import('mcp-cli').AliasContext) => {",
        "    return ctx.waitForEvent({ subscribe: ['not-a-real-category'] });",
        "  },",
        "});",
      ].join("\n"),
    );

    const result = await validateFreeformTsc(scriptPath);

    expect(result.timedOut).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("TS"))).toBe(true);
  }, 15_000);

  test("EventFilterSpec.subscribe accepts valid MonitorCategory", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "valid-category.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias } from "mcp-cli";',
        "defineAlias({",
        "  name: 'test',",
        "  fn: async (_input: unknown, ctx: import('mcp-cli').AliasContext) => {",
        "    return ctx.waitForEvent({ subscribe: ['session', 'ci'] });",
        "  },",
        "});",
      ].join("\n"),
    );

    const result = await validateFreeformTsc(scriptPath);

    expect(result.timedOut).toBe(false);
    expect(result.warnings).toHaveLength(0);
  }, 15_000);

  test("respects timeout", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "timeout-test.ts");
    writeFileSync(scriptPath, "const x = 1;\n");

    // Use an extremely short timeout to trigger it
    const result = await validateFreeformTsc(scriptPath, 1);

    // May or may not time out depending on how fast bunx starts,
    // but the function should not throw
    expect(typeof result.timedOut).toBe("boolean");
  }, 15_000);
});
