#!/usr/bin/env bun
/**
 * Compiled binary smoke tests.
 *
 * Exercises dist/mcx, dist/mcpd, and dist/mcpctl with basic operations
 * to catch build-time issues (missing entrypoints, broken defines, etc.).
 *
 * Run after `bun run build`:
 *   bun run smoke-test
 *
 * Exits 0 if all checks pass, 1 if any fail.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";

const MCX = resolve("dist/mcx");
const MCPD = resolve("dist/mcpd");
const MCPCTL = resolve("dist/mcpctl");

const SMOKE_ALIAS = "_smoke-test";
const SMOKE_SCRIPT = `
import { defineAlias, z } from "mcp-cli";
export default defineAlias({
  name: "${SMOKE_ALIAS}",
  description: "Smoke test alias",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  handler: async () => ({ ok: true }),
});
`;

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  const start = performance.now();
  try {
    await fn();
    results.push({ name, passed: true, durationMs: performance.now() - start });
    console.error(`  ✓ ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, error: msg, durationMs: performance.now() - start });
    console.error(`  ✗ ${name}: ${msg}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ── Pre-flight: check binaries exist ──

console.error("Smoke testing compiled binaries...\n");

for (const [label, path] of [
  ["mcx", MCX],
  ["mcpd", MCPD],
  ["mcpctl", MCPCTL],
] as const) {
  if (!existsSync(path)) {
    console.error(`ERROR: ${label} binary not found at ${path}`);
    console.error("Run 'bun run build' first.");
    process.exit(1);
  }
}

// ── Tests ──

await run("mcx version exits 0 and contains version string", async () => {
  const result = await $`${MCX} version --json`.quiet();
  assert(result.exitCode === 0, `exit code ${result.exitCode}`);
  const output = result.stdout.toString();
  const parsed = JSON.parse(output);
  assert(typeof parsed.client?.version === "string", "missing client.version");
  assert(parsed.client.version !== "0.0.0-dev", `version not injected: ${parsed.client.version}`);
});

await run("mcpd --help exits 0", async () => {
  const result = await $`${MCPD} --help`.quiet();
  assert(result.exitCode === 0, `exit code ${result.exitCode}`);
});

await run("mcpctl --version exits 0", async () => {
  const result = await $`${MCPCTL} --version`.quiet();
  assert(result.exitCode === 0, `exit code ${result.exitCode}`);
});

await run("mcx ls exits 0", async () => {
  const result = await $`${MCX} ls`.quiet().nothrow();
  assert(result.exitCode === 0, `exit code ${result.exitCode}`);
});

await run("mcx alias save/call/delete cycle", async () => {
  // Save
  const save = await $`echo ${SMOKE_SCRIPT} | ${MCX} alias save ${SMOKE_ALIAS} --stdin`.quiet().nothrow();
  assert(save.exitCode === 0, `alias save exit code ${save.exitCode}: ${save.stderr.toString()}`);

  try {
    // Call
    const call = await $`${MCX} call _aliases ${SMOKE_ALIAS} '{}'`.quiet().nothrow();
    assert(call.exitCode === 0, `alias call exit code ${call.exitCode}: ${call.stderr.toString()}`);
    const output = JSON.parse(call.stdout.toString());
    assert(output.ok === true, `unexpected output: ${JSON.stringify(output)}`);
  } finally {
    // Delete (always clean up)
    await $`${MCX} alias delete ${SMOKE_ALIAS}`.quiet().nothrow();
  }
});

// ── Summary ──

console.error("");
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

console.error(`${passed} passed, ${failed} failed (${(totalMs / 1000).toFixed(1)}s)`);

if (failed > 0) {
  process.exit(1);
}
