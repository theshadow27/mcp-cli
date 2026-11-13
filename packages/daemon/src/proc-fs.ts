/**
 * Linux /proc fallbacks used when `lsof` is not installed.
 *
 * Complements `getPortHolder` and `findProcessesByCwd` so production worktree
 * reaping and port-conflict diagnostics still work on a bare Linux box. #3459
 */

import { readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";

const LISTEN_STATE = "0A"; // TCP_LISTEN in /proc/net/tcp{,6}

/** PIDs (other than `excludePid`) whose cwd is `dirPath` or a subdirectory of it. */
export function findPidsByCwdLinux(dirPath: string, excludePid: number = process.pid): number[] {
  let root: string;
  try {
    root = realpathSync(dirPath);
  } catch {
    return [];
  }
  const prefix = root.endsWith("/") ? root : `${root}/`;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) continue;
    const pid = Number.parseInt(ent, 10);
    if (pid === excludePid) continue;
    try {
      const cwd = realpathSync(`/proc/${pid}/cwd`);
      if (cwd === root || cwd.startsWith(prefix)) pids.push(pid);
    } catch {
      // EACCES, ENOENT, or a process that exited mid-scan
    }
  }
  return pids;
}

/**
 * Identify the process listening on a TCP port via /proc/net/tcp{,6}
 * and `/proc/<pid>/fd` socket inodes.
 * Returns e.g. "mcpd (PID 38291)" or null.
 */
export function getPortHolderLinux(port: number): string | null {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const inodes = new Set<number>([...listenInodes("/proc/net/tcp", port), ...listenInodes("/proc/net/tcp6", port)]);
  if (inodes.size === 0) return null;

  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) continue;
    const fdDir = `/proc/${ent}/fd`;
    let fds: string[];
    try {
      fds = readdirSync(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(`${fdDir}/${fd}`);
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (!match) continue;
        const inode = Number.parseInt(match[1] as string, 10);
        if (!inodes.has(inode)) continue;
        const comm = readComm(Number.parseInt(ent, 10));
        return `${comm} (PID ${ent})`;
      } catch {
        // raced with close
      }
    }
  }
  return null;
}

/** Exported for unit tests. */
export function parseListenInodes(content: string, port: number): number[] {
  const inodes: number[] = [];
  const lines = content.split("\n");
  // First line is a header ("sl  local_address ...")
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]?.trim().split(/\s+/) ?? [];
    // sl, local_address, rem_address, st, ..., inode (index 9)
    if (cols.length < 10) continue;
    if (cols[3] !== LISTEN_STATE) continue;
    const local = cols[1] ?? "";
    const colon = local.lastIndexOf(":");
    if (colon < 0) continue;
    const portHex = local.slice(colon + 1);
    if (Number.parseInt(portHex, 16) !== port) continue;
    const inode = Number.parseInt(cols[9] as string, 10);
    if (Number.isInteger(inode) && inode > 0) inodes.push(inode);
  }
  return inodes;
}

function listenInodes(path: string, port: number): number[] {
  try {
    return parseListenInodes(readFileSync(path, "utf8"), port);
  } catch {
    return [];
  }
}

function readComm(pid: number): string {
  try {
    const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    if (comm) return comm;
  } catch {
    // fall through
  }
  return "unknown";
}
