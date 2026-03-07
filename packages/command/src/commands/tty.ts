/**
 * mcx tty open <command> — launch a shell command in a terminal instance.
 *
 * Modes:
 *   (default)    New tab in configured terminal
 *   --window     New window in configured terminal
 *   --headless   Bun.spawn() — no terminal, log to ~/.mcp-cli/logs/
 *
 * Terminal preference: `mcx config set terminal <name>`
 * Auto-detect: falls back to $TERM_PROGRAM / $TMUX if not configured.
 */

import type { CliConfig } from "@mcp-cli/core";
import { readCliConfig } from "@mcp-cli/core";
import { printError } from "../output";
import type { TerminalAdapter, TtyMode } from "../tty/adapter";
import { TERMINAL_NAMES, getAdapter } from "../tty/adapter";
import { detectTerminal } from "../tty/detect";
import type { HeadlessResult } from "../tty/headless";
import { spawnHeadless as defaultSpawnHeadless } from "../tty/headless";

// -- Arg parsing --

export interface TtyArgs {
  command: string | undefined;
  mode: TtyMode;
  headless: boolean;
  error: string | undefined;
}

export function parseTtyOpenArgs(args: string[]): TtyArgs {
  let mode: TtyMode = "tab";
  let headless = false;
  const parts: string[] = [];

  for (const arg of args) {
    if (arg === "--window") {
      mode = "window";
    } else if (arg === "--headless") {
      headless = true;
    } else if (arg === "--help" || arg === "-h") {
      return { command: undefined, mode, headless, error: undefined };
    } else {
      parts.push(arg);
    }
  }

  if (headless && mode === "window") {
    return { command: undefined, mode, headless, error: "--headless and --window are mutually exclusive" };
  }

  const command = parts.length > 0 ? parts.join(" ") : undefined;
  return { command, mode, headless, error: undefined };
}

// -- Dependency injection --

export interface TtyDeps {
  readCliConfig: () => CliConfig;
  detectTerminal: (env?: Record<string, string | undefined>) => string | undefined;
  getAdapter: (name: string) => TerminalAdapter;
  spawnHeadless: (cmd: string) => Promise<HeadlessResult>;
  printError: (msg: string) => void;
  exit: (code: number) => never;
}

const defaultDeps: TtyDeps = {
  readCliConfig,
  detectTerminal,
  getAdapter,
  spawnHeadless: defaultSpawnHeadless,
  printError,
  exit: (code) => process.exit(code),
};

// -- Command handler --

function printTtyUsage(): void {
  console.log(`mcx tty open — launch a command in a terminal instance

Usage:
  mcx tty open <command>              Open in new tab (default)
  mcx tty open --window <command>     Open in new window
  mcx tty open --headless <command>   Run as background process

Supported terminals: ${TERMINAL_NAMES.join(", ")}

Configure: mcx config set terminal <name>
Auto-detect: uses $TERM_PROGRAM / $TMUX if not configured`);
}

export async function cmdTty(args: string[], deps?: Partial<TtyDeps>): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printTtyUsage();
    return;
  }

  if (sub !== "open") {
    const d = { ...defaultDeps, ...deps };
    d.printError(`Unknown tty subcommand: ${sub}. Use "open".`);
    d.exit(1);
  }

  await ttyOpen(args.slice(1), deps);
}

export async function ttyOpen(args: string[], deps?: Partial<TtyDeps>): Promise<void> {
  const d: TtyDeps = { ...defaultDeps, ...deps };
  const parsed = parseTtyOpenArgs(args);

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  if (!parsed.command) {
    printTtyUsage();
    return;
  }

  // Headless mode — no terminal needed
  if (parsed.headless) {
    const result = await d.spawnHeadless(parsed.command);
    console.log(JSON.stringify({ pid: result.pid, logFile: result.logFile }));
    return;
  }

  // Resolve terminal adapter
  const config = d.readCliConfig();
  const terminalName = config.terminal ?? d.detectTerminal();

  if (!terminalName) {
    d.printError(
      `No terminal configured and auto-detect failed.\nSet one with: mcx config set terminal <name>\nSupported: ${TERMINAL_NAMES.join(", ")}`,
    );
    d.exit(1);
  }

  const adapter = d.getAdapter(terminalName);
  await adapter.open(parsed.command, parsed.mode);
  console.error(`Opened in ${adapter.name} (${parsed.mode})`);
}
