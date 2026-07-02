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
 * Isolation: every subprocess runs against a throwaway MCP_CLI_DIR (never the
 * user's real ~/.mcp-cli) so `mcx ls`, alias mutations, and the auto-started
 * daemon can't touch live state. Mirrors the pattern in scripts/build.ts
 * (smokeDaemonWorkers). The dir + daemon are torn down at exit.
 *
 * Exits 0 if all checks pass, 1 if any fail.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";

// Isolated runtime state — set before any subprocess spawn so the compiled
// binaries (which read MCP_CLI_DIR from the env) never touch real user state.
// wsPort: 0 lets the daemon pick an ephemeral WS port instead of colliding
// with a real running daemon on the well-known port.
const STATE_DIR = mkdtempSync(join(tmpdir(), "mcx-smoke-"));
writeFileSync(join(STATE_DIR, "config.json"), JSON.stringify({ wsPort: 0 }));
process.env.MCP_CLI_DIR = STATE_DIR;

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

// mcpd has no one-shot "print and exit" mode — any invocation boots the full
// daemon (it ignores --help and blocks until idle-timeout). Booting the
// compiled dist/mcpd is already covered by scripts/build.ts (smokeDaemonWorkers,
// run on every build) and end-to-end below by "mcx agent mock spawn", so there
// is no separate mcpd liveness check here.

await run("mcpctl boots and refuses non-TTY gracefully", async () => {
  // mcpctl is a TUI with no one-shot flag; the only deterministic, non-hanging
  // liveness check is that the compiled binary boots far enough to hit its
  // no-TTY guard. `$` pipes stdout, so the child always sees isTTY === false.
  const result = await $`${MCPCTL}`.quiet().nothrow();
  assert(result.exitCode === 1, `expected exit 1 (no-TTY guard), got ${result.exitCode}`);
  assert(
    result.stderr.toString().includes("requires a terminal"),
    `expected no-TTY guard message, got: ${result.stderr.toString()}`,
  );
});

await run("mcx ls exits 0", async () => {
  const result = await $`${MCX} ls`.quiet().nothrow();
  assert(result.exitCode === 0, `exit code ${result.exitCode}`);
});

await run("mcx alias save/call/delete cycle", async () => {
  // NOTE: this check currently fails on the compiled binary due to #2821
  // (compiled daemon can't resolve ./alias-executor.ts; the error is also
  // printed to stdout with exit 0, which is why it went unnoticed). That is
  // the smoke doing its job — catching a real compiled-binary regression. It
  // will pass once #2821 lands.
  // Save (source token "-" reads the script from stdin)
  const save = await $`echo ${SMOKE_SCRIPT} | ${MCX} alias save ${SMOKE_ALIAS} -`.quiet().nothrow();
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

await run("mcx agent mock spawn --wait (session worker startup)", async () => {
  // Exercises the full compiled mcx → mcpd → mock session worker path. This is
  // the exact runtime code path that regressed in #2762 (compiled session
  // workers failing with ModuleNotFound while `bun build` stayed green) — a
  // failure `bun test` on source can never catch.
  const scriptPath = join(STATE_DIR, "mock-script.json");
  writeFileSync(scriptPath, JSON.stringify([{ delay: 0, text: "smoke ok" }]));

  const spawn = await $`${MCX} agent mock spawn --task ${scriptPath} --wait`.quiet().nothrow();
  assert(spawn.exitCode === 0, `mock spawn exit code ${spawn.exitCode}: ${spawn.stderr.toString()}`);
  assert(
    spawn.stdout.toString().includes("session:result"),
    `expected session:result in output, got: ${spawn.stdout.toString()}`,
  );
});

// ── Teardown: stop the isolated daemon and remove the state dir ──

async function teardown(): Promise<void> {
  // The daemon auto-started by mcx runs against STATE_DIR — terminate it so it
  // doesn't linger, then remove the throwaway state.
  try {
    const pidPath = join(STATE_DIR, "mcpd.pid");
    if (existsSync(pidPath)) {
      const { pid } = JSON.parse(readFileSync(pidPath, "utf-8")) as { pid: number };
      if (typeof pid === "number") process.kill(pid, "SIGTERM");
    }
  } catch {
    // Daemon already gone or pidfile malformed — nothing to stop.
  }
  rmSync(STATE_DIR, { recursive: true, force: true });
}

await teardown();

// ── Summary ──

console.error("");
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

console.error(`${passed} passed, ${failed} failed (${(totalMs / 1000).toFixed(1)}s)`);

if (failed > 0) {
  process.exit(1);
}
