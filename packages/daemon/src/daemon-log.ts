/**
 * Daemon-level log capture.
 *
 * Monkey-patches console.error to capture daemon output in a ring buffer,
 * while still forwarding to the original stderr for foreground usage.
 */

import { type StderrLine, StderrRingBuffer } from "./stderr-buffer.js";

const DAEMON_KEY = "__daemon__";
const DAEMON_CAPACITY = 200;

const buffer = new StderrRingBuffer(DAEMON_CAPACITY);

let installed = false;

/** Intercept console.error to capture daemon logs. Call once at startup. */
export function installDaemonLogCapture(): void {
  if (installed) return;
  installed = true;

  const original = console.error.bind(console);

  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    buffer.push(DAEMON_KEY, line);
    original(...args);
  };
}

/** Retrieve captured daemon log lines. */
export function getDaemonLogLines(limit?: number): StderrLine[] {
  return buffer.getLines(DAEMON_KEY, limit);
}
