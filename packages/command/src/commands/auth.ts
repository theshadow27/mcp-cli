/**
 * `mcx auth` — authenticate with OAuth servers and check auth status.
 *
 * Subcommands:
 *   mcx auth              List servers with auth status
 *   mcx auth <server>     Trigger login flow
 *   mcx auth <server> --status   Check auth status only
 */

import type { IpcMethod, IpcMethodResult, ServerAuthStatus } from "@mcp-cli/core";
import { ipcCall as defaultIpcCall } from "../daemon-lifecycle";
import { c } from "../output";
import { extractJsonFlag } from "../parse";

export interface AuthDeps {
  ipcCall: <M extends IpcMethod>(method: M, params?: unknown) => Promise<IpcMethodResult[M]>;
  log: (msg: string) => void;
  logError: (msg: string) => void;
}

const defaultDeps: AuthDeps = {
  ipcCall: defaultIpcCall,
  log: (msg) => console.log(msg),
  logError: (msg) => console.error(msg),
};

function printHelp(log: (msg: string) => void): void {
  log(`mcx auth — authenticate with MCP servers

Usage:
  mcx auth                      List all servers with auth status
  mcx auth <server>             Trigger authentication (OAuth or auth tool)
  mcx auth <server> --status    Check auth status without triggering login

Flags:
  --json, -j     Output as JSON
  --status       Check status only (don't trigger auth flow)
  --help, -h     Show this help`);
}

export function statusLabel(s: ServerAuthStatus): string {
  switch (s.status) {
    case "authenticated":
      return `${c.green}authenticated${c.reset}`;
    case "expired":
      return `${c.red}expired${c.reset}`;
    case "not_authenticated":
      return `${c.yellow}not authenticated${c.reset}`;
    case "unknown":
      return `${c.dim}unknown${c.reset}`;
  }
}

export function authSupportLabel(s: ServerAuthStatus): string {
  switch (s.authSupport) {
    case "oauth":
      return "oauth";
    case "auth_tool":
      return "auth tool";
    case "none":
      return `${c.dim}n/a${c.reset}`;
  }
}

export function extractAuthFlags(args: string[]): { status: boolean; help: boolean; rest: string[] } {
  const rest: string[] = [];
  let status = false;
  let help = false;

  for (const arg of args) {
    if (arg === "--status") {
      status = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else {
      rest.push(arg);
    }
  }

  return { status, help, rest };
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex -- intentionally matching ANSI escape sequences
  const ESC = String.fromCharCode(0x1b);
  return s.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
}

export async function cmdAuth(args: string[], deps?: Partial<AuthDeps>): Promise<void> {
  const d: AuthDeps = { ...defaultDeps, ...deps };

  // Extract flags
  const { json, rest: r1 } = extractJsonFlag(args);
  const { status: statusOnly, help, rest } = extractAuthFlags(r1);

  if (help) {
    printHelp(d.log);
    return;
  }

  const server = rest[0];

  // No server specified — list all servers with auth status
  if (!server) {
    const result = await d.ipcCall("authStatus");

    if (json) {
      d.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.servers.length === 0) {
      d.log("No servers configured.");
      return;
    }

    // Table output
    const nameWidth = Math.max(6, ...result.servers.map((s) => s.server.length));
    d.log(`${c.bold}${"SERVER".padEnd(nameWidth)}  ${"TRANSPORT".padEnd(9)}  ${"AUTH".padEnd(10)}  STATUS${c.reset}`);
    for (const s of result.servers) {
      const authLabel = authSupportLabel(s);
      const authPad = 10 + (authLabel.length - Bun.stringWidth(authLabel));
      d.log(`${s.server.padEnd(nameWidth)}  ${s.transport.padEnd(9)}  ${authLabel.padEnd(authPad)}  ${statusLabel(s)}`);
    }
    return;
  }

  // Server specified with --status: check only
  if (statusOnly) {
    const result = await d.ipcCall("authStatus", { server });
    const entry = result.servers[0];

    if (json) {
      d.log(JSON.stringify(entry, null, 2));
      return;
    }

    d.log(`${c.bold}Server${c.reset}: ${c.cyan}${entry.server}${c.reset}`);
    d.log(`${c.bold}Auth${c.reset}: ${authSupportLabel(entry)}`);
    d.log(`${c.bold}Status${c.reset}: ${statusLabel(entry)}`);
    if (entry.expiresAt) {
      const remaining = Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000));
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      d.log(`${c.bold}Expires${c.reset}: ${mins}m ${secs}s`);
    }
    return;
  }

  // Server specified without --status: trigger auth
  d.logError(`Authenticating with ${server}...`);
  const result = await d.ipcCall("triggerAuth", { server });

  if (json) {
    d.log(JSON.stringify({ ok: result.ok, message: result.message, server }, null, 2));
    return;
  }

  d.logError(result.message);
}
