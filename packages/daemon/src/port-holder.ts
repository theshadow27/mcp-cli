/**
 * Identify the process listening on a given TCP port via lsof.
 * Returns e.g. "mcpd (PID 38291)" or null if nothing found / lsof unavailable.
 */

import { execFile } from "node:child_process";

/** `lsof` port-holder probe — diagnostic only, must not block daemon shutdown. */
const LSOF_PROBE_TIMEOUT_MS = 2_000;

export function getPortHolder(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "lsof",
      ["-i", `TCP:${port}`, "-sTCP:LISTEN", "-n", "-P"],
      { timeout: LSOF_PROBE_TIMEOUT_MS },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        // Skip header line, parse first result
        const lines = stdout.trim().split("\n");
        if (lines.length < 2) return resolve(null);
        const parts = lines[1].split(/\s+/);
        const command = parts[0];
        const pid = parts[1];
        if (command && pid) return resolve(`${command} (PID ${pid})`);
        resolve(null);
      },
    );
  });
}
