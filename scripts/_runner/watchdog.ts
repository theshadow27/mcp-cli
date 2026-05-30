/**
 * Test-worker watchdog — SIGKILL wedged `bun test --test-worker` processes.
 *
 * Bun's `--timeout` flag is a soft signal: it aborts the test harness, but a
 * worker stuck in a tight loop (e.g. the bmalloc madvise EAGAIN busy-spin,
 * bun#17723) never processes it. Only SIGKILL works. This watchdog polls for
 * descendant test-worker processes and kills their process group when elapsed
 * wall-clock time exceeds the threshold.
 *
 * Wall-clock elapsed time is the correct signal, not CPU time — under
 * contention, starved spinners accrue CPU time too slowly to trip a CPU-time
 * threshold (sprint 69 lesson).
 */

import { spawnSync } from "node:child_process";

import type { Logger } from "./types";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_ELAPSED_THRESHOLD_S = 120;
const PS_TIMEOUT_MS = 5_000;

export interface WatchdogOptions {
  parentPid: number;
  elapsedThresholdSeconds?: number;
  pollIntervalMs?: number;
  logger?: Logger;
}

export interface WatchdogHandle {
  stop: () => void;
  /** Number of processes killed so far. */
  killed: number;
}

interface WorkerInfo {
  pid: number;
  elapsedSeconds: number;
}

/**
 * Parse `ps -eo pid,ppid,etime,command` output to find test-worker descendants
 * of the given parent PID. Works on both macOS and Linux.
 *
 * etime format: `[[DD-]HH:]MM:SS`
 */
function parseEtime(etime: string): number {
  const trimmed = etime.trim();
  let days = 0;
  let rest = trimmed;

  const dashIdx = rest.indexOf("-");
  if (dashIdx >= 0) {
    days = Number.parseInt(rest.slice(0, dashIdx), 10) || 0;
    rest = rest.slice(dashIdx + 1);
  }

  const parts = rest.split(":").map((p) => Number.parseInt(p, 10) || 0);
  if (parts.length === 3) {
    return days * 86400 + (parts[0] as number) * 3600 + (parts[1] as number) * 60 + (parts[2] as number);
  }
  if (parts.length === 2) {
    return days * 86400 + (parts[0] as number) * 60 + (parts[1] as number);
  }
  return 0;
}

function findDescendantPids(parentPid: number): Set<number> {
  const result = spawnSync("ps", ["-eo", "pid,ppid"], { encoding: "utf8", timeout: PS_TIMEOUT_MS });
  if (result.status !== 0 || !result.stdout) return new Set();

  const childMap = new Map<number, number[]>();
  for (const line of result.stdout.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number.parseInt(parts[0] as string, 10);
    const ppid = Number.parseInt(parts[1] as string, 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const children = childMap.get(ppid);
    if (children) children.push(pid);
    else childMap.set(ppid, [pid]);
  }

  const descendants = new Set<number>();
  const queue = [parentPid];
  while (queue.length > 0) {
    const current = queue.pop() as number;
    const children = childMap.get(current);
    if (!children) continue;
    for (const child of children) {
      if (!descendants.has(child)) {
        descendants.add(child);
        queue.push(child);
      }
    }
  }
  return descendants;
}

function findWedgedWorkers(parentPid: number, thresholdSeconds: number): WorkerInfo[] {
  const descendants = findDescendantPids(parentPid);
  if (descendants.size === 0) return [];

  const result = spawnSync("ps", ["-eo", "pid,etime,command"], { encoding: "utf8", timeout: PS_TIMEOUT_MS });
  if (result.status !== 0 || !result.stdout) return [];

  const wedged: WorkerInfo[] = [];
  for (const line of result.stdout.split("\n").slice(1)) {
    const match = line.match(/^\s*(\d+)\s+([\d:.-]+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1] as string, 10);
    if (!descendants.has(pid)) continue;
    const command = match[3] as string;
    if (!command.includes("--test-worker")) continue;

    const elapsed = parseEtime(match[2] as string);
    if (elapsed >= thresholdSeconds) {
      wedged.push({ pid, elapsedSeconds: elapsed });
    }
  }
  return wedged;
}

function killProcessGroup(pid: number, logger?: Logger): boolean {
  try {
    process.kill(-pid, 9);
    logger?.warn(`[watchdog] SIGKILL sent to process group ${pid}`);
    return true;
  } catch {
    try {
      process.kill(pid, 9);
      logger?.warn(`[watchdog] SIGKILL sent to process ${pid} (pgroup kill failed)`);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Start a watchdog that periodically scans for wedged test-worker processes
 * descended from `parentPid` and SIGKILLs their process group.
 *
 * Returns a handle to stop the watchdog and query kill count.
 */
export function startWatchdog(opts: WatchdogOptions): WatchdogHandle {
  const threshold = opts.elapsedThresholdSeconds ?? DEFAULT_ELAPSED_THRESHOLD_S;
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const logger = opts.logger;
  const handle: WatchdogHandle = { stop: () => {}, killed: 0 };

  const timer = setInterval(() => {
    try {
      const wedged = findWedgedWorkers(opts.parentPid, threshold);
      for (const w of wedged) {
        logger?.warn(
          `[watchdog] test-worker pid ${w.pid} wedged (${w.elapsedSeconds}s elapsed, threshold ${threshold}s) — killing process group`,
        );
        if (killProcessGroup(w.pid, logger)) {
          handle.killed++;
        }
      }
    } catch {
      // watchdog must never crash the parent
    }
  }, interval);

  timer.unref();

  handle.stop = () => {
    clearInterval(timer);
  };

  return handle;
}

export { parseEtime, findWedgedWorkers, findDescendantPids };
