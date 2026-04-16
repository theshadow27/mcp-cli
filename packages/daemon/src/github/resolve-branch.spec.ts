import { describe, expect, test } from "bun:test";
import { resolveBranchFromPr } from "./resolve-branch";

const repo = { owner: "octo", repo: "cat" };

function fakeProc(opts: {
  stdout?: string;
  exitCode?: number;
  exitDelayMs?: number;
  killable?: boolean;
}): ReturnType<typeof Bun.spawn> {
  let killed = false;
  let resolveExit: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const timer = setTimeout(() => {
    if (!killed) resolveExit(opts.exitCode ?? 0);
  }, opts.exitDelayMs ?? 0);

  return {
    exited,
    kill: () => {
      killed = true;
      clearTimeout(timer);
      resolveExit(143); // SIGTERM conventional
    },
    stdout: new Response(opts.stdout ?? "").body,
    stderr: new Response("").body,
  } as unknown as ReturnType<typeof Bun.spawn>;
}

describe("resolveBranchFromPr", () => {
  test("returns trimmed branch name on success", async () => {
    let receivedArgs: string[] = [];
    const spawn = ((args: string[]) => {
      receivedArgs = args;
      return fakeProc({ stdout: "feat/my-branch\n" });
    }) as unknown as typeof Bun.spawn;

    const branch = await resolveBranchFromPr(42, { repo, spawn });

    expect(branch).toBe("feat/my-branch");
    expect(receivedArgs).toContain("--repo");
    expect(receivedArgs).toContain("octo/cat");
    expect(receivedArgs).toContain("42");
  });

  test("returns null on non-zero exit", async () => {
    const spawn = (() => fakeProc({ exitCode: 1, stdout: "" })) as unknown as typeof Bun.spawn;
    const branch = await resolveBranchFromPr(42, { repo, spawn });
    expect(branch).toBeNull();
  });

  test("returns null on empty stdout", async () => {
    const spawn = (() => fakeProc({ stdout: "   \n" })) as unknown as typeof Bun.spawn;
    const branch = await resolveBranchFromPr(42, { repo, spawn });
    expect(branch).toBeNull();
  });

  test("kills subprocess on timeout and returns null", async () => {
    let killCalled = false;
    const spawn = (() => {
      const proc = fakeProc({ stdout: "late/branch", exitDelayMs: 500 });
      const origKill = proc.kill.bind(proc);
      proc.kill = () => {
        killCalled = true;
        origKill();
      };
      return proc;
    }) as unknown as typeof Bun.spawn;

    const branch = await resolveBranchFromPr(42, { repo, spawn, timeoutMs: 20 });

    expect(killCalled).toBe(true);
    expect(branch).toBeNull();
  });

  test("returns null when spawn throws (e.g., gh not installed)", async () => {
    const spawn = (() => {
      throw new Error("gh: command not found");
    }) as unknown as typeof Bun.spawn;

    let debugMsg: string | undefined;
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: (msg: string) => {
        debugMsg = msg;
      },
    };

    const branch = await resolveBranchFromPr(42, { repo, spawn, logger });

    expect(branch).toBeNull();
    expect(debugMsg).toContain("spawn failed");
    expect(debugMsg).toContain("gh: command not found");
  });

  test("passes --repo flag so cwd-based repo inference is never used", async () => {
    let receivedArgs: string[] = [];
    const spawn = ((args: string[]) => {
      receivedArgs = args;
      return fakeProc({ stdout: "main" });
    }) as unknown as typeof Bun.spawn;

    await resolveBranchFromPr(1, { repo: { owner: "alice", repo: "tools" }, spawn });

    const repoIdx = receivedArgs.indexOf("--repo");
    expect(repoIdx).toBeGreaterThan(-1);
    expect(receivedArgs[repoIdx + 1]).toBe("alice/tools");
  });
});
