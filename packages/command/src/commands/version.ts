/**
 * mcx version — show CLI, daemon, and protocol versions.
 *
 * Output (human-readable):
 *   Client:  mcx 0.1.0-20260308 (protocol: a3f2b1c9d0e1)
 *   Daemon:  mcpd 0.1.0-dev (protocol: a3f2b1c9d0e1, uptime: 2h31m)
 *   Status:  protocol match
 *
 * Output (--json / -j):
 *   { "client": { "version": "...", "protocol": "..." },
 *     "daemon": { "version": "...", "protocol": "...", "uptimeSeconds": N } | null,
 *     "protocolMatch": true }
 *
 * If the daemon is not running, the Daemon line shows "(not running)".
 */

import type { DaemonStatus, IpcMethod, IpcMethodResult } from "@mcp-cli/core";
import { BUILD_VERSION, PING_TIMEOUT_MS, PROTOCOL_VERSION } from "@mcp-cli/core";

export interface VersionDeps {
  ipcCall: <M extends IpcMethod>(
    method: M,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ) => Promise<IpcMethodResult[M]>;
  buildVersion: string;
  protocolVersion: string;
  exit: (code: number) => never;
}

const defaultDeps: VersionDeps = {
  ipcCall: async (method, params, opts) => {
    const { ipcCall: coreIpc } = await import("../daemon-lifecycle.js");
    return coreIpc(method, params, opts) as never;
  },
  buildVersion: BUILD_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  exit: (code) => process.exit(code),
};

export async function cmdVersion(args: string[], deps?: Partial<VersionDeps>): Promise<void> {
  const d = { ...defaultDeps, ...deps };
  const json = args.includes("--json") || args.includes("-j");

  let daemon: DaemonStatus | null = null;
  try {
    daemon = await d.ipcCall("status", undefined, { timeoutMs: PING_TIMEOUT_MS });
  } catch {
    // Daemon not running — show client-only info
  }

  if (json) {
    const out = {
      client: {
        version: d.buildVersion,
        protocol: d.protocolVersion,
      },
      daemon: daemon
        ? {
            version: daemon.daemonVersion ?? "unknown",
            protocol: daemon.protocolVersion,
            uptimeSeconds: Math.round(daemon.uptime),
          }
        : null,
      protocolMatch: daemon ? daemon.protocolVersion === d.protocolVersion : null,
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // Human-readable output
  console.log(`Client:  mcx ${d.buildVersion} (protocol: ${d.protocolVersion})`);

  if (daemon) {
    const uptime = formatUptime(daemon.uptime);
    const daemonVer = daemon.daemonVersion ?? "unknown";
    console.log(`Daemon:  mcpd ${daemonVer} (protocol: ${daemon.protocolVersion}, uptime: ${uptime})`);

    if (daemon.protocolVersion === d.protocolVersion) {
      console.log("Status:  protocol match");
    } else {
      console.log("Status:  protocol MISMATCH — run 'bun build && mcx daemon restart'");
    }
  } else {
    console.log("Daemon:  (not running)");
    console.log("Status:  daemon offline");
  }
}

function formatUptime(seconds: number): string {
  const totalSeconds = Math.round(seconds);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}
