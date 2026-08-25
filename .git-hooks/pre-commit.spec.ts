import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

setDefaultTimeout(15_000);

const PRE_COMMIT = resolve(import.meta.dir, "pre-commit");

/** Strip GIT_* env vars so git ops in the temp repo don't inherit GIT_DIR/GIT_INDEX_FILE
 *  from an outer `git commit` invocation and commit into the developer's branch (#2527). */
function cleanGitEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

async function sh(cwd: string, cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, env: cleanGitEnv(), stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${cmd.join(" ")} (cwd=${cwd}) exited ${code}: ${err}`);
  }
}

describe("pre-commit hook tiers", () => {
  let root: string;
  let repo: string;
  let stubDir: string;
  let callLog: string;

  /** Stage `files` in the temp repo, run the real hook, return exit code + what
   *  it asked `bun` to do. `bun` is a stub on PATH that records its argv and
   *  exits 0, so the hook's *intent* is observable without running the gate. */
  async function runHook(files: Record<string, string>): Promise<{ code: number; stdout: string; bunCalls: string[] }> {
    for (const [path, content] of Object.entries(files)) {
      const abs = join(repo, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      await sh(repo, ["git", "add", "--", path]);
    }
    const proc = Bun.spawn([PRE_COMMIT], {
      cwd: repo,
      env: cleanGitEnv({ PATH: `${stubDir}:${process.env.PATH ?? ""}`, BUN_CALL_LOG: callLog }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    const logged = readFileSync(callLog, "utf8").trim();
    return { code, stdout, bunCalls: logged === "" ? [] : logged.split("\n") };
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "pre-commit-"));
    repo = join(root, "repo");
    stubDir = join(root, "stub");
    callLog = join(root, "bun-calls.txt");
    mkdirSync(repo, { recursive: true });
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(callLog, "");

    const stub = join(stubDir, "bun");
    writeFileSync(stub, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$BUN_CALL_LOG"\nexit 0\n');
    chmodSync(stub, 0o755);

    await sh(repo, ["git", "init", "-q", "-b", "main"]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // #3344: the hook used to run `bun run test:coverage` on any source change —
  // the full suite plus the ratchet, invoked directly rather than through the
  // am-i-done step table, so the `lease: true` admission control (#2690) never
  // applied. Commits are static-only now; pre-push runs the diff-aware subset
  // and CI owns the full suite + coverage.
  test("source changes run the static gate and no tests", async () => {
    const { code, bunCalls } = await runHook({ "packages/core/src/thing.ts": "export const x = 1;\n" });

    expect(code).toBe(0);
    expect(bunCalls).toContain("run am-i-done --pre-commit");
    expect(bunCalls.some((c) => /\btest\b|test:coverage/.test(c))).toBe(false);
  });

  test("config-only changes run the static gate and no tests", async () => {
    const { code, bunCalls } = await runHook({ "package.json": '{ "name": "temp" }\n' });

    expect(code).toBe(0);
    expect(bunCalls).toContain("run am-i-done --pre-commit");
    expect(bunCalls.some((c) => /\btest\b|test:coverage/.test(c))).toBe(false);
  });

  test("docs-only changes run nothing at all", async () => {
    const { code, stdout, bunCalls } = await runHook({ "README.md": "docs\n" });

    expect(code).toBe(0);
    expect(bunCalls).toEqual([]);
    expect(stdout).toContain("Docs-only changes detected");
  });

  test("an empty index skips every check", async () => {
    const { code, stdout, bunCalls } = await runHook({});

    expect(code).toBe(0);
    expect(bunCalls).toEqual([]);
    expect(stdout).toContain("No staged files");
  });

  // The static gate is a hard gate: a non-zero am-i-done fails the commit.
  test("a failing static gate fails the commit", async () => {
    writeFileSync(join(stubDir, "bun"), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$BUN_CALL_LOG"\nexit 1\n');
    chmodSync(join(stubDir, "bun"), 0o755);

    const { code } = await runHook({ "packages/core/src/thing.ts": "export const x = 1;\n" });

    expect(code).not.toBe(0);
  });
});
