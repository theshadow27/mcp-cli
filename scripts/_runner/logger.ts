/**
 * Logger factories for the step runner.
 *
 * mcp-cli is literally called "Model Context Preservation" — when a step
 * fails inside a Claude session, the failure output is usually the largest
 * single context dump in the session. The AI file-logger writes everything
 * to `build/am-i-done-<timestamp>.txt`, prints one line ("Full logs saved
 * to: …") on failure, and deletes the file on success. The orchestrator
 * keeps its context budget; the human or follow-up agent can `cat` the
 * file when they need detail.
 *
 * Three factories:
 *
 *   - createConsoleLogger: pretty stdout/stderr for sh/ci.
 *   - createCaptureLogger: buffers messages; show/clear on demand. Used
 *     for the "silent first, verbose on failure" runner pattern.
 *   - createAiFileLogger: writes ANSI-stripped output to a file, mirrors
 *     warn/error to stderr so the user still knows when something broke.
 */

import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Logger } from "./types";

const ANSI = /\x1b\[[0-9;]*m/g;

function format(args: unknown[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack ?? a.message : JSON.stringify(a)))
    .join(" ");
}

export function createConsoleLogger(): Logger {
  return {
    debug: (...args) => console.debug(...args),
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  };
}

export interface CaptureLogger extends Logger {
  show: (sink: Logger) => void;
  clear: () => void;
}

/**
 * Buffers every message. The runner runs each step against a capture logger
 * first; on success it discards the buffer, on failure it replays it to the
 * real logger before emitting the failure banner.
 */
export function createCaptureLogger(): CaptureLogger {
  const buffer: Array<{ level: keyof Logger; args: unknown[] }> = [];
  const push = (level: keyof Logger) => (...args: unknown[]) => {
    buffer.push({ level, args });
  };
  return {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    show: (sink) => {
      for (const { level, args } of buffer) sink[level](...args);
    },
    clear: () => {
      buffer.length = 0;
    },
  };
}

export interface AiFileLogger extends Logger {
  path: string;
  finalize: (success: boolean) => Promise<void>;
}

/**
 * Returns a logger that writes ANSI-stripped output to a timestamped file
 * under build/. warn/error are also mirrored to stderr so the human/agent
 * gets a real-time signal that something is going wrong, but info/debug
 * are file-only — that's where the bulk of the volume hides.
 */
export function createAiFileLogger(repoRoot: string): AiFileLogger {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").split("Z")[0];
  const path = join(repoRoot, "build", `am-i-done-${ts}.txt`);
  const lines: string[] = [];

  const write = (level: string, args: unknown[]) => {
    lines.push(`[${level}] ${format(args).replace(ANSI, "")}`);
  };

  return {
    path,
    debug: (...a) => write("DEBUG", a),
    info: (...a) => write("INFO", a),
    warn: (...a) => {
      write("WARN", a);
      console.warn(...a);
    },
    error: (...a) => {
      write("ERROR", a);
      console.error(...a);
    },
    finalize: async (success) => {
      if (success) {
        try {
          await unlink(path);
        } catch {
          /* file may not exist if nothing was written */
        }
        return;
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, lines.join("\n") + "\n", "utf8");
    },
  };
}
