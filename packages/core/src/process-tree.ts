/**
 * Process-tree helpers.
 *
 * When a spawned command is a wrapper (a pnpm/nvm/nix `bun` shim, a shell
 * script, etc.) SIGTERM of the wrapper PID only kills the wrapper and
 * orphans the real process. Callers that later signal `handle.pid` must
 * also signal descendants — and must collect those PIDs *before* killing
 * the wrapper, or the grandchild is reparented to PID 1 and lost. #3459
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";

const MAX_DESCENDANTS = 256;
const PGREP_TIMEOUT_MS = 2_000;

/**
 * Direct children of `pid`. Linux uses `/proc/<pid>/task/<pid>/children`
 * (and a /proc status scan if that file is missing). macOS uses `pgrep -P`.
 */
export function listChildPids(pid: number): number[] {
  // Never walk PID 1 (init/launchd): its tree is the whole machine, and a
  // caller like killPid(1) (the EPERM fixture) would SIGTERM the test
  // runner and every sibling. #3459
  if (!Number.isInteger(pid) || pid <= 1) return [];
  if (process.platform === "linux") return linuxChildren(pid);
  if (process.platform === "darwin") return pgrepChildren(pid);
  return [];
}

/** All descendants of `pid`, breadth-first, not including `pid` itself. */
export function listDescendantPids(pid: number): number[] {
  if (!Number.isInteger(pid) || pid <= 1) return [];
  const out: number[] = [];
  const seen = new Set<number>([pid]);
  const queue = listChildPids(pid);
  while (queue.length > 0 && out.length < MAX_DESCENDANTS) {
    const child = queue.shift() as number;
    if (seen.has(child)) continue;
    seen.add(child);
    out.push(child);
    for (const grand of listChildPids(child)) {
      if (!seen.has(grand)) queue.push(grand);
    }
  }
  return out;
}

/**
 * Signal `pid` and every current descendant. Descendants are snapshotted
 * first so a wrapper that dies immediately cannot hide its child.
 *
 * Returns the number of processes the signal was delivered to.
 */
export function signalProcessTree(pid: number, signal: NodeJS.Signals): number {
  const targets = [pid, ...listDescendantPids(pid)];
  let delivered = 0;
  for (const target of targets) {
    try {
      process.kill(target, signal);
      delivered++;
    } catch {
      // ESRCH / EPERM — already gone or not ours
    }
  }
  return delivered;
}

function linuxChildren(pid: number): number[] {
  const path = `/proc/${pid}/task/${pid}/children`;
  try {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8").trim();
      if (!text) return [];
      return parsePidList(text);
    }
  } catch {
    // unreadable or gone — fall through to the status scan
  }
  return linuxChildrenByStatusScan(pid);
}

function linuxChildrenByStatusScan(parent: number): number[] {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const kids: number[] = [];
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) continue;
    const child = Number.parseInt(ent, 10);
    if (child === parent) continue;
    try {
      const status = readFileSync(`/proc/${child}/status`, "utf8");
      const match = status.match(/^PPid:\s*(\d+)/m);
      if (match && Number.parseInt(match[1] as string, 10) === parent) {
        kids.push(child);
      }
    } catch {
      // raced with exit, or EACCES
    }
  }
  return kids;
}

function pgrepChildren(pid: number): number[] {
  // Lazy import avoids a cycle: subprocess.ts imports this module.
  const { spawnCaptureSync } = require("./subprocess") as typeof import("./subprocess");
  const result = spawnCaptureSync("pgrep", ["-P", String(pid)], { timeoutMs: PGREP_TIMEOUT_MS });
  if (!result.ok || !result.stdout) return [];
  return parsePidList(result.stdout);
}

function parsePidList(text: string): number[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/\s+/)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}
