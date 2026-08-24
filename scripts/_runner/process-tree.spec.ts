import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { killTrackedTree, spawnTracked, trackedPids } from "./process-tree";

// Everything here spawns real processes: the whole point of the #3261 kill is
// that it survives contact with the OS, so a fake-process test would pin
// nothing. Keep it cheap — one bun child, one `sleep` grandchild.
const POLL_MS = 20;
const WAIT_BUDGET_MS = 4_000;

const tempDirs: string[] = [];
const strays: number[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "process-tree-"));
  tempDirs.push(d);
  return d;
}

afterEach(async () => {
  // Belt and braces: if the implementation regresses, don't leak a spinner.
  await killTrackedTree({ graceMs: POLL_MS });
  for (const pid of strays.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

// A signal-0 probe is the only way to ask "does this pid still exist"; the throw
// IS the negative answer, so there is no error here to assert on.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
    // dotw-ignore test-empty-catch: ESRCH is the "not alive" answer, not a swallowed failure
  } catch {
    return false;
  }
}

/** Poll a condition to a deadline — test the CONDITION, never time passing. */
async function waitFor(label: string, cond: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_BUDGET_MS;
  while (Date.now() < deadline) {
    if (cond()) return;
    await Bun.sleep(POLL_MS);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/**
 * Spawn a tracked child that itself spawns a long-lived grandchild and then
 * hangs forever without ever forwarding signals. If only the direct child is
 * signalled, the grandchild is re-parented to init and survives — which is
 * exactly the #2973 wedge this module exists to reap.
 */
function spawnTreeWithGrandchild(pidPath: string): { childPid: number } {
  const dir = tempDir();
  const script = join(dir, "parent.ts");
  writeFileSync(
    script,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const gc = spawn("sleep", ["30"], { stdio: "ignore" });',
      `writeFileSync(${JSON.stringify(pidPath)}, String(gc.pid));`,
      "await new Promise(() => {});",
    ].join("\n"),
  );
  const child = spawnTracked("bun", [script], { env: { ...process.env } as Record<string, string> });
  expect(child.pid).toBeDefined();
  return { childPid: child.pid as number };
}

function readPid(path: string): number | null {
  if (!existsSync(path)) return null;
  const n = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

describe("process-tree", () => {
  it("killTrackedTree is a no-op when nothing is tracked", async () => {
    const result = await killTrackedTree();
    expect(result.killed).toEqual([]);
    expect(result.survivors).toEqual([]);
  });

  it("kills the whole tree — a grandchild the direct child never signals dies too", async () => {
    const pidPath = join(tempDir(), "grandchild.pid");
    const { childPid } = spawnTreeWithGrandchild(pidPath);
    expect(trackedPids()).toContain(childPid);

    await waitFor("grandchild to report its pid", () => readPid(pidPath) !== null);
    const gcPid = readPid(pidPath) as number;
    strays.push(gcPid, childPid);
    expect(alive(gcPid)).toBe(true);

    const result = await killTrackedTree({ graceMs: WAIT_BUDGET_MS });

    expect(result.killed).toContain(childPid);
    expect(result.survivors).toEqual([]);
    // The load-bearing assertion: the grandchild, not just the child.
    await waitFor("grandchild to die", () => !alive(gcPid));
    expect(alive(gcPid)).toBe(false);
    expect(alive(childPid)).toBe(false);
  });

  it("forgets a child once it exits, so a later kill has nothing to signal", async () => {
    const child = spawnTracked("true", [], { env: { ...process.env } as Record<string, string> });
    const pid = child.pid as number;
    expect(trackedPids()).toContain(pid);
    await waitFor("child to exit and deregister", () => !trackedPids().includes(pid));

    const result = await killTrackedTree();
    expect(result.killed).toEqual([]);
  });
});
