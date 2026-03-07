/**
 * Headless process spawning — launches a command as a background process
 * with stdout/stderr captured to a log file in ~/.mcp-cli/logs/.
 */

import { existsSync, mkdirSync } from "node:fs";
import { options } from "@mcp-cli/core";

export interface HeadlessResult {
  pid: number;
  logFile: string;
}

export type HeadlessSpawnFn = (command: string, logFile: string) => { pid: number; unref: () => void };

const defaultHeadlessSpawn: HeadlessSpawnFn = (command, logFile) => {
  const proc = Bun.spawn(["sh", "-c", command], {
    stdout: Bun.file(logFile),
    stderr: Bun.file(logFile),
    stdin: "ignore",
  });
  return { pid: proc.pid, unref: () => proc.unref() };
};

export async function spawnHeadless(
  command: string,
  spawn: HeadlessSpawnFn = defaultHeadlessSpawn,
  logsDir: string = options.LOGS_DIR,
): Promise<HeadlessResult> {
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }

  const timestamp = Date.now();
  const logFile = `${logsDir}/${timestamp}.log`;

  const proc = spawn(command, logFile);
  proc.unref();

  return { pid: proc.pid, logFile };
}
