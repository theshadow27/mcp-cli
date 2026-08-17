/**
 * End-to-end coverage for `mcx call`'s ephemeral auto-save (#696) and the
 * "Run again" hint it prints (#2983).
 *
 * Two invariants, neither of which had a test before:
 *   1. stdout purity — `mcx call` writes ONLY the tool payload to stdout; the
 *      hint goes to stderr. Nothing in the suite would have caught a regression
 *      that moved it onto stdout.
 *   2. hint truthfulness — when the hint names an alias, `mcx run <name>` must
 *      actually work. It did not: the save was fire-and-forget and
 *      `process.exit()` cut the socket write short, so the alias never existed.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { type TestDaemon, echoServerConfig, startTestDaemon } from "./harness";

setDefaultTimeout(30_000);

const MCX_SCRIPT = resolve("packages/command/src/main.ts");

/** Run `mcx` as a child process against the test daemon's isolated dir. */
async function mcx(dir: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // CLAUDE=1 would engage size protection and rewrite stdout; this test asserts
  // on the raw payload path, so unset it explicitly.
  const env: Record<string, string | undefined> = { ...process.env, MCP_CLI_DIR: dir, CLAUDE: undefined };

  await using proc = Bun.spawn(["bun", MCX_SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("mcx call — ephemeral alias auto-save", () => {
  let daemon: TestDaemon;

  beforeAll(async () => {
    daemon = await startTestDaemon({ echo: echoServerConfig() }, { skipVirtualServers: false });
  });

  afterAll(async () => {
    await daemon.kill();
  });

  test("hint goes to stderr and the alias it names is runnable", async () => {
    // Echo back a JSON document so stdout is parseable, and make the serialized
    // args exceed EPHEMERAL_ALIAS_CHAR_THRESHOLD (400) so auto-save triggers.
    const payload = { pad: "x".repeat(600) };
    const callArgs = JSON.stringify({ message: JSON.stringify(payload) });
    expect(callArgs.length).toBeGreaterThan(400);

    const call = await mcx(daemon.dir, ["call", "echo", "echo", callArgs]);

    // (a) stdout is the payload and nothing else — no hint line in front of it
    expect(JSON.parse(call.stdout)).toEqual(payload);
    expect(call.stdout).not.toContain("mcx run");
    expect(call.exitCode).toBe(0);

    // (b) the hint landed on stderr
    const match = call.stderr.match(/Run again: mcx run (\S+)/);
    expect(match?.[1]).toBeDefined();
    const aliasName = match?.[1] as string;

    // (c) the alias the hint advertised really exists and replays the call
    const run = await mcx(daemon.dir, ["run", aliasName]);
    expect(run.stderr).not.toContain("not found");
    expect(JSON.parse(run.stdout)).toEqual(payload);
    expect(run.exitCode).toBe(0);
  });

  test("no hint and no alias when args are below the threshold", async () => {
    const call = await mcx(daemon.dir, ["call", "echo", "echo", JSON.stringify({ message: "short" })]);

    expect(call.stdout.trim()).toBe("short");
    expect(call.stderr).not.toContain("Run again");
    expect(call.exitCode).toBe(0);
  });
});
