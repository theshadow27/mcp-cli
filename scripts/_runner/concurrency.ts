/**
 * Concurrency cap for parallel am-i-done runs.
 *
 * Under sprint orchestration, N concurrent Claude sessions each spawn
 * `bun run am-i-done`, which spawns `bun test --parallel` with up to
 * `--max-concurrency=20` workers each. On a 10-core machine with 7 sessions
 * that's 140 potential workers — the oversubscription triggers a bun bmalloc
 * madvise EAGAIN busy-spin that wedges workers at 100% CPU forever (#2597).
 *
 * This module detects sibling am-i-done runs via sentinel files and computes
 * a safe `--max-concurrency` that keeps total workers ≤ CPU count.
 */

import { readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

const SENTINEL_DIR = "/tmp";
const SENTINEL_PREFIX = "mcp-cli-am-i-done-";
const SENTINEL_SUFFIX = ".sentinel";

function sentinelPath(pid: number): string {
  return join(SENTINEL_DIR, `${SENTINEL_PREFIX}${pid}${SENTINEL_SUFFIX}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

function countLiveSiblings(): number {
  let count = 0;
  try {
    for (const f of readdirSync(SENTINEL_DIR)) {
      if (!f.startsWith(SENTINEL_PREFIX) || !f.endsWith(SENTINEL_SUFFIX)) continue;
      const pidStr = f.slice(SENTINEL_PREFIX.length, -SENTINEL_SUFFIX.length);
      const pid = Number.parseInt(pidStr, 10);
      if (!Number.isFinite(pid)) continue;
      if (pid === process.pid) continue;
      if (isProcessAlive(pid)) {
        count++;
      } else {
        try {
          unlinkSync(join(SENTINEL_DIR, f));
        } catch {
          // race — another process already cleaned it
        }
      }
    }
  } catch {
    // /tmp unreadable — treat as no siblings
  }
  return count;
}

export interface ConcurrencyGuard {
  maxConcurrency: number;
  siblingCount: number;
  cleanup: () => void;
}

/**
 * Acquire a concurrency sentinel and compute safe `--max-concurrency`.
 *
 * Formula: `max(2, floor(cpuCount / totalRuns))` where totalRuns includes
 * this process. The floor of 2 ensures progress even under extreme load.
 */
export function acquireConcurrencyGuard(): ConcurrencyGuard {
  const myPath = sentinelPath(process.pid);
  try {
    writeFileSync(myPath, `${process.pid}\n${Date.now()}\n`);
  } catch {
    // non-fatal — we'll just run at default concurrency
  }

  const siblings = countLiveSiblings();
  const totalRuns = siblings + 1;
  const cpuCount = availableParallelism();
  const maxConcurrency = Math.max(2, Math.floor(cpuCount / totalRuns));

  const cleanup = () => {
    try {
      unlinkSync(myPath);
    } catch {
      // already gone
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  return { maxConcurrency, siblingCount: siblings, cleanup };
}
