/**
 * Daemon-level log capture.
 *
 * Monkey-patches console.error to capture daemon output in a ring buffer,
 * while still forwarding to the original stderr for foreground usage.
 * Optionally writes to a persistent log file for post-mortem debugging.
 */

import { appendFileSync, closeSync, openSync, renameSync, statSync } from "node:fs";
import { DAEMON_LOG_MAX_BYTES, options } from "@mcp-cli/core";
import { type StderrLine, StderrRingBuffer, type StderrSubscriber } from "./stderr-buffer";

const DAEMON_KEY = "__daemon__";
const DAEMON_CAPACITY = 200;

const buffer = new StderrRingBuffer(DAEMON_CAPACITY);

let installed = false;
let logFd: number | null = null;
let logPath: string = options.DAEMON_LOG_PATH;
let logBackupPath: string = options.DAEMON_LOG_BACKUP_PATH;
let logMaxBytes: number = DAEMON_LOG_MAX_BYTES;
let logWriteCount = 0;

/**
 * Intercept all console log methods to capture daemon logs. Call once at startup.
 *
 * The daemon reserves stdout for the ready signal — all log output must go to stderr.
 * This patches console.error, console.warn, console.info, and console.debug to:
 * 1. Capture to the ring buffer
 * 2. Forward to stderr (via the original console.error)
 * 3. Write to the persistent log file
 */
export function installDaemonLogCapture(): void {
  if (installed) return;
  installed = true;

  const originalError = console.error.bind(console);

  const intercept = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    buffer.push(DAEMON_KEY, line);
    try {
      originalError(...args);
    } catch {
      // EPIPE: parent terminal disconnected — silently swallow
    }
    writeToLogFile(line);
  };

  console.error = intercept;
  console.warn = intercept;
  console.info = intercept;
  console.debug = intercept;
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
  logPath = opts?.path ?? options.DAEMON_LOG_PATH;
  logBackupPath = opts?.backupPath ?? options.DAEMON_LOG_BACKUP_PATH;
  if (opts?.maxBytes !== undefined) logMaxBytes = opts.maxBytes;
  logWriteCount = 0;
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

/** Subscribe to new daemon log lines. Returns an unsubscribe function. */
export function subscribeDaemonLogs(fn: (entry: StderrLine) => void): () => void {
  const wrapper: StderrSubscriber = (server, entry) => {
    if (server === DAEMON_KEY) fn(entry);
  };
  return buffer.subscribe(wrapper);
}

function writeToLogFile(line: string): void {
  if (logFd === null) return;
  try {
    if (++logWriteCount >= options.LOG_ROTATION_CHECK_INTERVAL) {
      logWriteCount = 0;
      rotateIfNeeded();
    }
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
