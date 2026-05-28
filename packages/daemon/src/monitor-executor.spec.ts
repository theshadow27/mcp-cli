import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bundleAlias } from "@mcp-cli/core";

setDefaultTimeout(10_000);

const EXECUTOR_PATH = resolve("packages/daemon/src/monitor-executor.ts");

function makeTmpDir(): string {
  const dir = join(tmpdir(), `monitor-executor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeScript(dir: string, name: string, source: string): string {
  const path = join(dir, `${name}.ts`);
  writeFileSync(path, source);
  return path;
}

async function bundleScript(filePath: string): Promise<string> {
  const result = await bundleAlias(filePath);
  return result.js;
}

async function runExecutor(
  bundledJs: string,
  aliasName: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, EXECUTOR_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const payload = JSON.stringify({ bundledJs, aliasName });
  proc.stdin.write(payload);
  await proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode: exitCode ?? 1 };
}

function parseNdjson(stdout: string): Record<string, unknown>[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("monitor-executor", () => {
  test("yields 3 events produces exactly 3 NDJSON lines on stdout", async () => {
    const dir = makeTmpDir();
    const scriptPath = writeScript(
      dir,
      "ticker",
      `import { defineMonitor } from "mcp-cli";
defineMonitor({
  name: "ticker",
  subscribe: async function*(ctx) {
    for (let i = 0; i < 3; i++) {
      yield { event: "tick", category: "heartbeat", count: i };
    }
  },
});`,
    );

    const bundledJs = await bundleScript(scriptPath);
    const { stdout, exitCode } = await runExecutor(bundledJs, "ticker");

    expect(exitCode).toBe(0);
    const events = parseNdjson(stdout);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ event: "tick", count: 0 });
    expect(events[2]).toMatchObject({ event: "tick", count: 2 });
  });

  test("no double-emit: yielded events appear exactly once", async () => {
    const dir = makeTmpDir();
    const scriptPath = writeScript(
      dir,
      "no-double",
      `import { defineMonitor } from "mcp-cli";
defineMonitor({
  name: "no-double",
  subscribe: async function*(ctx) {
    yield { event: "yielded", n: 1 };
    yield { event: "yielded", n: 2 };
  },
});`,
    );

    const bundledJs = await bundleScript(scriptPath);
    const { stdout, exitCode } = await runExecutor(bundledJs, "no-double");

    expect(exitCode).toBe(0);
    const events = parseNdjson(stdout);
    expect(events).toHaveLength(2);
  });

  test("logger writes go to stderr, not stdout", async () => {
    const dir = makeTmpDir();
    const scriptPath = writeScript(
      dir,
      "logger-test",
      `import { defineMonitor } from "mcp-cli";
defineMonitor({
  name: "logger-test",
  subscribe: async function*(ctx) {
    ctx.logger.info("hello from info");
    ctx.logger.warn("hello from warn");
    yield { event: "done" };
  },
});`,
    );

    const bundledJs = await bundleScript(scriptPath);
    const { stdout, stderr, exitCode } = await runExecutor(bundledJs, "logger-test");

    expect(exitCode).toBe(0);
    const events = parseNdjson(stdout);
    expect(events).toHaveLength(1);
    expect(stderr).toContain("hello from info");
    expect(stderr).toContain("hello from warn");
  });

  test("generator error exits non-zero", async () => {
    const dir = makeTmpDir();
    const scriptPath = writeScript(
      dir,
      "crasher",
      `import { defineMonitor } from "mcp-cli";
defineMonitor({
  name: "crasher",
  subscribe: async function*(ctx) {
    throw new Error("boom");
  },
});`,
    );

    const bundledJs = await bundleScript(scriptPath);
    const { exitCode, stderr } = await runExecutor(bundledJs, "crasher");

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("boom");
  });

  test("empty generator exits cleanly with no output", async () => {
    const dir = makeTmpDir();
    const scriptPath = writeScript(
      dir,
      "empty",
      `import { defineMonitor } from "mcp-cli";
defineMonitor({
  name: "empty",
  subscribe: async function*(ctx) {
    // yields nothing
  },
});`,
    );

    const bundledJs = await bundleScript(scriptPath);
    const { stdout, exitCode } = await runExecutor(bundledJs, "empty");

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });
});
