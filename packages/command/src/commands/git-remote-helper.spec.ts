import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGitRemoteHelperInvocation, parseRemoteUrl, runGitRemoteHelper } from "./git-remote-helper";

describe("isGitRemoteHelperInvocation", () => {
  test("matches bare name", () => {
    expect(isGitRemoteHelperInvocation("git-remote-mcx")).toBe(true);
  });

  test("matches absolute path", () => {
    expect(isGitRemoteHelperInvocation("/usr/local/bin/git-remote-mcx")).toBe(true);
  });

  test("matches .exe on Windows-like paths (forward slashes)", () => {
    expect(isGitRemoteHelperInvocation("C:/tools/git-remote-mcx.exe")).toBe(true);
  });

  test("matches .exe on Windows-native paths (backslashes)", () => {
    expect(isGitRemoteHelperInvocation("C:\\Program Files\\Git\\git-remote-mcx.exe")).toBe(true);
  });

  test("does not match normal mcx invocation", () => {
    expect(isGitRemoteHelperInvocation("/usr/local/bin/mcx")).toBe(false);
    expect(isGitRemoteHelperInvocation("mcx")).toBe(false);
    expect(isGitRemoteHelperInvocation("")).toBe(false);
  });

  test("does not match similar-looking names", () => {
    expect(isGitRemoteHelperInvocation("git-remote-mcp")).toBe(false);
    expect(isGitRemoteHelperInvocation("git-remote-mcx-backup")).toBe(false);
  });
});

describe("parseRemoteUrl", () => {
  test("parses provider + scope", () => {
    expect(parseRemoteUrl("mcx://confluence/FOO")).toEqual({
      provider: "confluence",
      scope: "FOO",
    });
  });

  test("parses jira URL", () => {
    expect(parseRemoteUrl("mcx://jira/PROJ")).toEqual({
      provider: "jira",
      scope: "PROJ",
    });
  });

  test("preserves multi-segment scope", () => {
    expect(parseRemoteUrl("mcx://github-issues/owner/repo")).toEqual({
      provider: "github-issues",
      scope: "owner/repo",
    });
  });

  test("rejects non-mcx scheme", () => {
    expect(() => parseRemoteUrl("https://example.com/foo")).toThrow(/mcx:\/\//);
  });

  test("rejects missing scope", () => {
    expect(() => parseRemoteUrl("mcx://confluence")).toThrow(/provider.*scope/);
    expect(() => parseRemoteUrl("mcx://confluence/")).toThrow(/provider.*scope/);
  });

  test("rejects missing provider", () => {
    expect(() => parseRemoteUrl("mcx:///scope")).toThrow(/provider.*scope/);
  });
});

describe("runGitRemoteHelper", () => {
  let gitDir: string;
  let savedGitEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    gitDir = mkdtempSync(join(tmpdir(), "mcx-grh-test-"));
    // Git hook environments (pre-commit, pre-push, etc.) set GIT_* vars that
    // can cause tests to pass for wrong reasons. Clear them all for isolation.
    savedGitEnv = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("GIT_")) {
        savedGitEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    rmSync(gitDir, { recursive: true, force: true });
    for (const [key, val] of Object.entries(savedGitEnv)) {
      process.env[key] = val;
    }
  });

  function emptyStdin(): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  }

  function streamFrom(input: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(input));
        controller.close();
      },
    });
  }

  function collect(): { stream: WritableStream<Uint8Array>; output: () => string } {
    const chunks: Uint8Array[] = [];
    const stream = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    });
    return { stream, output: () => new TextDecoder().decode(Buffer.concat(chunks)) };
  }

  test("fails fast on missing URL", async () => {
    const { stream } = collect();
    await expect(
      runGitRemoteHelper({
        argv: ["bun", "git-remote-mcx", "origin"],
        gitDir,
        stdin: emptyStdin(),
        stdout: stream,
      }),
    ).rejects.toThrow(/missing remote URL/);
  });

  test("fails fast on invalid URL scheme", async () => {
    const { stream } = collect();
    await expect(
      runGitRemoteHelper({
        argv: ["bun", "git-remote-mcx", "origin", "https://example.com"],
        gitDir,
        stdin: emptyStdin(),
        stdout: stream,
      }),
    ).rejects.toThrow(/mcx:\/\//);
  });

  test("requires GIT_DIR", async () => {
    // GIT_* env vars are cleared by beforeEach, so process.env.GIT_DIR is
    // absent here — the fallback must fail.
    const { stream } = collect();
    await expect(
      runGitRemoteHelper({
        argv: ["bun", "git-remote-mcx", "origin", "mcx://confluence/FOO"],
        stdin: emptyStdin(),
        stdout: stream,
      }),
    ).rejects.toThrow(/GIT_DIR/);
  });

  test("responds to capabilities command", async () => {
    const { stream, output } = collect();
    await runGitRemoteHelper({
      argv: ["bun", "git-remote-mcx", "origin", "mcx://confluence/FOO"],
      gitDir,
      stdin: streamFrom("capabilities\n\n"),
      stdout: stream,
    });
    const out = output();
    expect(out).toContain("import\n");
    expect(out).toContain("export\n");
    expect(out).toContain(`${gitDir}/mcx/marks`);
  });

  test("EOF on stdin exits cleanly without invoking handlers", async () => {
    const { stream } = collect();
    await runGitRemoteHelper({
      argv: ["bun", "git-remote-mcx", "origin", "mcx://confluence/FOO"],
      gitDir,
      stdin: emptyStdin(),
      stdout: stream,
    });
  });

  test("creates marksDir under GIT_DIR", async () => {
    const { stream } = collect();
    await runGitRemoteHelper({
      argv: ["bun", "git-remote-mcx", "origin", "mcx://confluence/FOO"],
      gitDir,
      stdin: emptyStdin(),
      stdout: stream,
    });
    expect(existsSync(join(gitDir, "mcx"))).toBe(true);
  });

  test("list stub returns empty refs without throwing", async () => {
    const { stream, output } = collect();
    await runGitRemoteHelper({
      argv: ["bun", "git-remote-mcx", "origin", "mcx://confluence/FOO"],
      gitDir,
      stdin: streamFrom("list\n\n"),
      stdout: stream,
    });
    // list handler returns "" → protocol writes "\n" (empty ref list terminator).
    // No stack trace, no thrown exception.
    expect(output()).toBe("\n");
  });

  test("import stub returns done without throwing", async () => {
    const { stream, output } = collect();
    await runGitRemoteHelper({
      argv: ["bun", "git-remote-mcx", "origin", "mcx://confluence/FOO"],
      gitDir,
      stdin: streamFrom("import refs/heads/main\n\n"),
      stdout: stream,
    });
    expect(output()).toContain("done\n");
  });

  test("export stub consumes stdin and returns without throwing", async () => {
    const { stream } = collect();
    await runGitRemoteHelper({
      argv: ["bun", "git-remote-mcx", "origin", "mcx://confluence/FOO"],
      gitDir,
      stdin: streamFrom("export\ndone\n"),
      stdout: stream,
    });
  });
});
