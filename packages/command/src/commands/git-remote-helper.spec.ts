import { describe, expect, test } from "bun:test";
import { isGitRemoteHelperInvocation, parseRemoteUrl, runGitRemoteHelper } from "./git-remote-helper";

describe("isGitRemoteHelperInvocation", () => {
  test("matches bare name", () => {
    expect(isGitRemoteHelperInvocation("git-remote-mcx")).toBe(true);
  });

  test("matches absolute path", () => {
    expect(isGitRemoteHelperInvocation("/usr/local/bin/git-remote-mcx")).toBe(true);
  });

  test("matches .exe on Windows-like paths", () => {
    expect(isGitRemoteHelperInvocation("C:/tools/git-remote-mcx.exe")).toBe(true);
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
  function emptyStdin(): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
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
        gitDir: "/tmp/test-git",
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
        gitDir: "/tmp/test-git",
        stdin: emptyStdin(),
        stdout: stream,
      }),
    ).rejects.toThrow(/mcx:\/\//);
  });

  test("requires GIT_DIR", async () => {
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
    const stdin = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("capabilities\n\n"));
        controller.close();
      },
    });
    await runGitRemoteHelper({
      argv: ["bun", "git-remote-mcx", "origin", "mcx://confluence/FOO"],
      gitDir: "/tmp/test-git-dir",
      stdin,
      stdout: stream,
    });
    const out = output();
    expect(out).toContain("import\n");
    expect(out).toContain("export\n");
    expect(out).toContain("/tmp/test-git-dir/mcx/marks");
  });

  test("EOF on stdin exits cleanly without invoking handlers", async () => {
    const { stream } = collect();
    // No input → protocol loop returns immediately. Handlers would throw if called.
    await runGitRemoteHelper({
      argv: ["bun", "git-remote-mcx", "origin", "mcx://confluence/FOO"],
      gitDir: "/tmp/test-git-dir",
      stdin: emptyStdin(),
      stdout: stream,
    });
  });
});
