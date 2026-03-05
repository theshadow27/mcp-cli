/**
 * Daemon-level log capture.
 *
 * Monkey-patches console.error to capture daemon output in a ring buffer,
 * while still forwarding to the original stderr for foreground usage.
 * Optionally writes to a persistent log file for post-mortem debugging.
 */

import { appendFileSync, closeSync, openSync, renameSync, statSync } from "node:fs";
import { DAEMON_LOG_MAX_BYTES, options } from "@mcp-cli/core";
import { type StderrLine, StderrRingBuffer } from "./stderr-buffer.js";

const DAEMON_KEY = "__daemon__";
const DAEMON_CAPACITY = 200;

const buffer = new StderrRingBuffer(DAEMON_CAPACITY);

let installed = false;
let logFd: number | null = null;
let logPath: string = options.DAEMON_LOG_PATH;
let logBackupPath: string = options.DAEMON_LOG_BACKUP_PATH;
let logMaxBytes: number = DAEMON_LOG_MAX_BYTES;

/** Intercept console.error to capture daemon logs. Call once at startup. */
export function installDaemonLogCapture(): void {
  if (installed) return;
  installed = true;

  const original = console.error.bind(console);

  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    buffer.push(DAEMON_KEY, line);
    original(...args);
    writeToLogFile(line);
  };
}

/**
 * Open the persistent daemon log file for appending.
 * Call after installDaemonLogCapture() at daemon startup.
 * Accepts optional overrides for testing.
 */
export function installDaemonLogFile(opts?: {
  path?: string;
  backupPath?: string;
  maxBytes?: number;
}): void {
  if (opts?.path) logPath = opts.path;
  if (opts?.backupPath) logBackupPath = opts.backupPath;
  if (opts?.maxBytes !== undefined) logMaxBytes = opts.maxBytes;
  logFd = openSync(logPath, "a");
}

/** Close the daemon log file. Call during graceful shutdown. */
export function closeDaemonLogFile(): void {
  if (logFd !== null) {
    try {
      closeSync(logFd);
    } catch {
      // fd may already be invalid
    }
    logFd = null;
  }
}

/** Retrieve captured daemon log lines. */
export function getDaemonLogLines(limit?: number): StderrLine[] {
  return buffer.getLines(DAEMON_KEY, limit);
}

function writeToLogFile(line: string): void {
  if (logFd === null) return;
  try {
    rotateIfNeeded();
    const entry = `${new Date().toISOString()} ${line}\n`;
    appendFileSync(logFd, entry);
  } catch {
    // Best-effort — don't crash the daemon for log writes
  }
}

function rotateIfNeeded(): void {
  try {
    const stat = statSync(logPath);
    if (stat.size < logMaxBytes) return;
  } catch {
    return; // file doesn't exist or can't stat — skip rotation
  }

  if (logFd !== null) {
    try {
      closeSync(logFd);
    } catch {
      // ignore
    }
  }

  try {
    renameSync(logPath, logBackupPath);
  } catch {
    // ignore — backup may be locked on some OS
  }

  logFd = openSync(logPath, "a");
}
