/**
 * Identify the process listening on a given TCP port.
 * Prefers `lsof` (macOS + Linux); falls back to /proc on Linux when lsof
 * is missing so port-conflict diagnostics still work. #3459
 * Returns e.g. "mcpd (PID 38291)" or null if nothing found.
 */

import { execFile } from "node:child_process";
import { getPortHolderLinux } from "./proc-fs";

/** `lsof` port-holder probe — diagnostic only, must not block daemon shutdown. */
const LSOF_PROBE_TIMEOUT_MS = 2_000;

export function getPortHolder(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "lsof",
      ["-i", `TCP:${port}`, "-sTCP:LISTEN", "-n", "-P"],
      { timeout: LSOF_PROBE_TIMEOUT_MS },
      (err, stdout) => {
        const fromLsof = parseLsofListen(err ? "" : stdout);
        if (fromLsof) {
          resolve(fromLsof);
          return;
        }
        // lsof missing, empty, or timed out — try /proc on Linux.
        if (process.platform === "linux") {
          resolve(getPortHolderLinux(port));
          return;
        }
        resolve(null);
      },
    );
  });
}

function parseLsofListen(stdout: string): string | null {
  if (!stdout) return null;
  const lines = stdout.trim().split("\n");
  if (lines.length < 2) return null;
  const parts = lines[1]?.split(/\s+/) ?? [];
  const command = parts[0];
  const pid = parts[1];
  if (command && pid) return `${command} (PID ${pid})`;
  return null;
}
