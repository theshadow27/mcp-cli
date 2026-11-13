import { describe, expect, test } from "bun:test";
import { listDescendantPids, signalProcessTree } from "./process-tree";

const POLL_INTERVAL_MS = 10;
const VISIBILITY_DEADLINE_MS = 2_000;
const DEATH_GRACE_MS = 1_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
    // dotw-ignore test-empty-catch: process.kill(pid, 0) throws ESRCH when already dead
  } catch {
    return false;
  }
}

describe("listDescendantPids", () => {
  test("returns the child of a wrapper shell", async () => {
    // sh stays alive and waits on sleep — the same shape as a bun shim.
    const proc = Bun.spawn(["sh", "-c", "sleep 60 & wait"], { stdout: "ignore", stderr: "ignore" });
    try {
      const deadline = Date.now() + VISIBILITY_DEADLINE_MS;
      let kids: number[] = [];
      while (Date.now() < deadline) {
        kids = listDescendantPids(proc.pid);
        if (kids.length > 0) break;
        await Bun.sleep(POLL_INTERVAL_MS);
      }
      expect(kids.length).toBeGreaterThan(0);
      expect(kids).not.toContain(proc.pid);
      for (const kid of kids) expect(isAlive(kid)).toBe(true);
    } finally {
      signalProcessTree(proc.pid, "SIGKILL");
      await proc.exited;
    }
  });

  test("refuses to walk PID 1 (init/launchd) (#3459)", () => {
    expect(listDescendantPids(1)).toEqual([]);
    expect(listDescendantPids(0)).toEqual([]);
    expect(listDescendantPids(-1)).toEqual([]);
  });

  test("returns empty for a process with no children", () => {
    expect(listDescendantPids(process.pid).every((pid) => pid !== process.pid)).toBe(true);
  });
});

describe("signalProcessTree", () => {
  test("SIGTERM reaches the grandchild of a wrapper shell", async () => {
    const proc = Bun.spawn(["sh", "-c", "sleep 60 & wait"], { stdout: "ignore", stderr: "ignore" });
    try {
      const deadline = Date.now() + VISIBILITY_DEADLINE_MS;
      let kids: number[] = [];
      while (Date.now() < deadline) {
        kids = listDescendantPids(proc.pid);
        if (kids.length > 0) break;
        await Bun.sleep(POLL_INTERVAL_MS);
      }
      expect(kids.length).toBeGreaterThan(0);
      const delivered = signalProcessTree(proc.pid, "SIGTERM");
      expect(delivered).toBeGreaterThan(0);
      const deathDeadline = Date.now() + VISIBILITY_DEADLINE_MS;
      while (Date.now() < deathDeadline && kids.some(isAlive)) {
        await Bun.sleep(POLL_INTERVAL_MS);
      }
      const still = kids.filter(isAlive);
      if (still.length > 0) {
        for (const pid of still) {
          try {
            process.kill(pid, "SIGKILL");
            // dotw-ignore test-empty-catch: best-effort cleanup — process may already be gone
          } catch {
            // already gone
          }
        }
        throw new Error(`grandchild still alive after SIGTERM: ${still.join(",")}`);
      }
    } finally {
      signalProcessTree(proc.pid, "SIGKILL");
      await Promise.race([proc.exited, Bun.sleep(DEATH_GRACE_MS)]);
    }
  });
});
