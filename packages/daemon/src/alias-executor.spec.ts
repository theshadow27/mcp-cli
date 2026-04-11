import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bundleAlias } from "@mcp-cli/core";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `alias-executor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const executorPath = join(import.meta.dir, "alias-executor.ts");

/** Spawn the executor subprocess with given stdin payload and return parsed stdout. */
async function runExecutor(
  payload: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", executorPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

describe("alias-executor subprocess protocol", () => {
  test("execute mode: returns result as JSON on stdout", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "greet.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, z } from "mcp-cli";',
        "defineAlias({",
        '  name: "greet",',
        "  input: z.object({ name: z.string() }),",
        "  fn: (input) => `Hello, ${input.name}!`,",
        "});",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    const { stdout, exitCode } = await runExecutor({
      bundledJs: js,
      input: { name: "World" },
      isDefineAlias: true,
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.result).toBe("Hello, World!");
  });

  test("validate mode: returns validation result as JSON on stdout", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "meta.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, z } from "mcp-cli";',
        "defineAlias({",
        '  name: "my-tool",',
        '  description: "A cool tool",',
        "  input: z.object({ query: z.string() }),",
        "  fn: (input) => input.query,",
        "});",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    const { stdout, exitCode } = await runExecutor({
      bundledJs: js,
      input: null,
      isDefineAlias: true,
      mode: "validate",
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.result.valid).toBe(true);
    expect(parsed.result.name).toBe("my-tool");
    expect(parsed.result.description).toBe("A cool tool");
    expect(parsed.result.inputSchema).toBeDefined();
  });

  test("error mode: returns structured error on stdout with exit code 1", async () => {
    const { stdout, exitCode } = await runExecutor({
      bundledJs: "this is not valid bundled JS {{{",
      input: {},
      isDefineAlias: true,
    });

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toBeDefined();
    expect(typeof parsed.error).toBe("string");
  });

  test("cache() writes to disk and returns cached value on second call", async () => {
    // Clean up BEFORE test to handle stale state from prior crashes (#1146)
    const cacheDir = join(homedir(), ".mcp-cli", "cache", "alias", "executor-cache-test");
    if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true });

    const dir = makeTmpDir();
    const scriptPath = join(dir, "cached.ts");
    // Script uses cache() — on first call writes file, on second call reads it
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, z } from "mcp-cli";',
        "defineAlias({",
        '  name: "cached",',
        "  input: z.object({ seed: z.string() }),",
        "  fn: async (input, ctx) => {",
        '    const val = await ctx.cache("test-key", () => input.seed);',
        "    return val;",
        "  },",
        "});",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);

    // First call: producer runs, value cached
    const first = await runExecutor({
      bundledJs: js,
      input: { seed: "original" },
      isDefineAlias: true,
      aliasName: "executor-cache-test",
    });
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout).result).toBe("original");

    // Second call with different seed: should return cached "original"
    const second = await runExecutor({
      bundledJs: js,
      input: { seed: "different" },
      isDefineAlias: true,
      aliasName: "executor-cache-test",
    });
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout).result).toBe("original");

    // Clean up cache files
    if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true });
  });

  test("cycle detection: errors when alias is already in callChain", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "cyclic.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, z } from "mcp-cli";',
        "defineAlias({",
        '  name: "cyclic",',
        "  input: z.object({ x: z.string() }),",
        "  fn: (input) => input.x,",
        "});",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    const { stdout, exitCode } = await runExecutor({
      bundledJs: js,
      input: { x: "test" },
      isDefineAlias: true,
      aliasName: "cyclic",
      callChain: ["parent", "cyclic"],
    });

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toContain("Alias cycle detected");
    expect(parsed.error).toContain("parent → cyclic → cyclic");
  });

  test("depth limit: errors when callChain exceeds max depth", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "deep.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, z } from "mcp-cli";',
        "defineAlias({",
        '  name: "deep",',
        "  input: z.object({ x: z.string() }),",
        "  fn: (input) => input.x,",
        "});",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    const chain = Array.from({ length: 16 }, (_, i) => `alias-${i}`);
    const { stdout, exitCode } = await runExecutor({
      bundledJs: js,
      input: { x: "test" },
      isDefineAlias: true,
      aliasName: "deep",
      callChain: chain,
    });

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toContain("too deep");
  });

  test("no cycle: succeeds when alias is not in callChain", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "nocycle.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, z } from "mcp-cli";',
        "defineAlias({",
        '  name: "nocycle",',
        "  input: z.object({ x: z.string() }),",
        "  fn: (input) => input.x,",
        "});",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    const { stdout, exitCode } = await runExecutor({
      bundledJs: js,
      input: { x: "hello" },
      isDefineAlias: true,
      aliasName: "nocycle",
      callChain: ["parent", "other"],
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.result).toBe("hello");
  });

  test("console.log in alias script does not corrupt stdout JSON", async () => {
    const dir = makeTmpDir();
    const scriptPath = join(dir, "noisy.ts");
    writeFileSync(
      scriptPath,
      [
        'import { defineAlias, z } from "mcp-cli";',
        'console.log("NOISE ON STDOUT");',
        'console.warn("MORE NOISE");',
        "defineAlias({",
        '  name: "noisy",',
        "  input: z.object({ x: z.string() }),",
        "  fn: (input) => input.x,",
        "});",
      ].join("\n"),
    );

    const { js } = await bundleAlias(scriptPath);
    const { stdout, stderr, exitCode } = await runExecutor({
      bundledJs: js,
      input: { x: "clean" },
      isDefineAlias: true,
    });

    expect(exitCode).toBe(0);
    // stdout must be valid JSON (not corrupted by console.log)
    const parsed = JSON.parse(stdout);
    expect(parsed.result).toBe("clean");
    // console output went to stderr
    expect(stderr).toContain("NOISE ON STDOUT");
    expect(stderr).toContain("MORE NOISE");
  });
});
