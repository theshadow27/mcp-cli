/**
 * `mcx automation` — introspect automation modules declared in `.mcx.yaml`.
 *
 * Subcommands:
 *   - `list`: show all declared modules, their events, and enabled state
 *   - `show <name>`: show details for a specific module
 *   - `log [name]`: show recent automation fires from the audit ring buffer
 *
 * #2018
 */

import { findGitRoot } from "@mcp-cli/core";
import type { AutomationModuleInfo, GetAutomationLogResult, ListAutomationResult } from "@mcp-cli/core";

export interface AutomationDeps {
  ipcCall: <T>(method: string, params?: unknown) => Promise<T>;
  cwd: () => string;
  log: (msg: string) => void;
  logError: (msg: string) => void;
  exit: (code: number) => never;
}

const defaultDeps: AutomationDeps = {
  ipcCall: async <T>(method: string, params?: unknown): Promise<T> => {
    const { ipcCall } = await import("../daemon-lifecycle");
    return ipcCall(method as Parameters<typeof ipcCall>[0], params as Parameters<typeof ipcCall>[1]) as T;
  },
  cwd: () => process.cwd(),
  log: (msg) => console.log(msg),
  logError: (msg) => console.error(msg),
  exit: (code) => process.exit(code),
};

export async function cmdAutomation(args: string[], deps?: Partial<AutomationDeps>): Promise<void> {
  const d: AutomationDeps = { ...defaultDeps, ...deps };
  const sub = args[0];

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printAutomationHelp(d);
    return;
  }

  const repoRoot = findGitRoot(d.cwd());
  if (!repoRoot) {
    d.logError("not inside a git repository");
    d.exit(1);
  }

  if (sub === "list" || sub === "ls") {
    await cmdList(repoRoot, d);
  } else if (sub === "show") {
    const name = args[1];
    if (!name) {
      d.logError("Usage: mcx automation show <name>");
      d.exit(1);
    }
    await cmdShow(repoRoot, name, d);
  } else if (sub === "log") {
    const limitIdx = args.indexOf("--limit");
    let limit: number | undefined;
    if (limitIdx >= 0) {
      // dotw-todo no-manual-arg-parsing: migrate to parseFlags — fix in #2283
      const raw = args[limitIdx + 1];
      const parsed = Number.parseInt(raw, 10);
      if (!raw || Number.isNaN(parsed) || parsed < 1) {
        d.logError(`--limit requires a positive integer, got: ${raw ?? "(missing)"}`);
        d.exit(1);
      }
      limit = parsed;
    }
    const firstPositional = args[1];
    const name = firstPositional && !firstPositional.startsWith("--") ? firstPositional : undefined;
    await cmdLog(repoRoot, name, limit, d);
  } else {
    d.logError(`Unknown subcommand: ${sub}`);
    printAutomationHelp(d);
    d.exit(1);
  }
}

async function cmdList(repoRoot: string, d: AutomationDeps): Promise<void> {
  const result = await d.ipcCall<ListAutomationResult>("listAutomation", { repoRoot });

  if (result.modules.length === 0) {
    d.log("No automation modules configured.");
    d.log("Add an automation: section to .mcx.yaml to declare modules.");
    return;
  }

  d.log(`Preset: ${result.preset}`);
  d.log(`Modules (${result.modules.length}):\n`);

  for (const mod of result.modules) {
    const status = mod.enabled ? "enabled" : "disabled";
    const fires = mod.recentFires > 0 ? `  (${mod.recentFires} recent fires)` : "";
    d.log(`  ${mod.name}  [${status}]${fires}`);
    d.log(`    source: ${mod.resolvedPath}`);
    d.log(`    events: ${mod.events.join(", ")}`);
  }
}

async function cmdShow(repoRoot: string, name: string, d: AutomationDeps): Promise<void> {
  const result = await d.ipcCall<ListAutomationResult>("listAutomation", { repoRoot });
  const mod = result.modules.find((m: AutomationModuleInfo) => m.name === name);

  if (!mod) {
    d.logError(`Module "${name}" not found.`);
    if (result.modules.length > 0) {
      d.logError(`Available: ${result.modules.map((m: AutomationModuleInfo) => m.name).join(", ")}`);
    }
    d.exit(1);
  }

  d.log(`Name:     ${mod.name}`);
  d.log(`Enabled:  ${mod.enabled}`);
  d.log(`Source:   ${mod.resolvedPath}`);
  d.log(`Hash:     ${mod.contentHash}`);
  d.log(`Events:   ${mod.events.join(", ")}`);
  d.log(`Fires:    ${mod.recentFires}`);
}

async function cmdLog(
  repoRoot: string,
  name: string | undefined,
  limit: number | undefined,
  d: AutomationDeps,
): Promise<void> {
  const result = await d.ipcCall<GetAutomationLogResult>("getAutomationLog", {
    repoRoot,
    ...(name && { module: name }),
    ...(limit && { limit }),
  });

  if (result.entries.length === 0) {
    d.log("No automation log entries.");
    return;
  }

  for (const entry of result.entries) {
    const ts = new Date(entry.ts).toLocaleTimeString();
    const wi = entry.workItemId ? ` wi:${entry.workItemId}` : "";
    const action = entry.actionType ? ` → ${entry.actionType}` : "";
    const err = entry.error ? ` error: ${entry.error}` : "";
    const skip = entry.skipReason ? ` skip: ${entry.skipReason}` : "";
    d.log(
      `[${ts}] ${entry.module}  ${entry.outcome}  trigger:${entry.event}${wi}${action}  ${entry.durationMs}ms${err}${skip}`,
    );
  }
}

function printAutomationHelp(d: AutomationDeps): void {
  d.log(`mcx automation — introspect automation modules

Subcommands:
  list              Show all declared modules and their status
  show <name>       Show details for a specific module
  log [name]        Show recent automation fires (optionally filtered by module)
    --limit <n>     Limit number of log entries (default: 50)

Automation modules are declared in .mcx.yaml under the automation: section.
Run 'mcx phase install' after editing automation sources to update .mcx.lock.`);
}
