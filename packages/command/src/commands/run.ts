/**
 * `mcx run <alias> [json-input] [--key value ...]` — execute an alias script.
 *
 * For defineAlias aliases, the first non-flag argument after the alias name
 * is treated as JSON input (e.g. '{"email": "foo@bar.com"}').
 * --key value pairs are passed as CLI args (available in ctx.args).
 */

import { relative, resolve } from "node:path";
import { type IpcMethod, type IpcMethodResult, options as coreOptions, ipcCall, readCliConfig } from "@mcp-cli/core";
import { runAlias } from "../alias-runner";
import { printError } from "../output";

export interface CmdRunDeps {
  ipcCall: <M extends IpcMethod>(method: M, params?: unknown) => Promise<IpcMethodResult[M]>;
  readCliConfig: () => ReturnType<typeof readCliConfig>;
  runAlias: typeof runAlias;
  printError: typeof printError;
  logError: (msg: string) => void;
  exit: (code: number) => never;
  cwd: () => string;
}

const defaultDeps: CmdRunDeps = {
  ipcCall,
  readCliConfig,
  runAlias,
  printError,
  logError: (msg) => console.error(msg),
  exit: (code) => process.exit(code),
  cwd: () => process.cwd(),
};

/**
 * Check whether an alias with `scope` is callable from `cwd`.
 * - `null`/`undefined`: always allowed (legacy)
 * - `"global"`: always allowed
 * - absolute path: allowed only when cwd starts with that path
 */
export function isScopeAllowed(scope: string | null | undefined, cwd: string): boolean {
  if (scope == null || scope === "global") return true;
  // Anything that isn't `null`, `"global"`, or an absolute path is malformed —
  // fail closed so a misconfigured scope can't accidentally grant global access.
  if (!scope.startsWith("/")) return false;
  const normalizedScope = resolve(scope);
  const normalizedCwd = resolve(cwd);
  if (normalizedCwd === normalizedScope) return true;
  const rel = relative(normalizedScope, normalizedCwd);
  // `relative` returns "" for same path, a non-".." path for inside,
  // and a path starting with ".." (or an absolute path on Windows) for outside.
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
}

export async function cmdRun(args: string[], deps?: Partial<CmdRunDeps>): Promise<{ _recordPromise: Promise<void> }> {
  const d: CmdRunDeps = { ...defaultDeps, ...deps };
  const aliasName = args[0];
  if (!aliasName) {
    d.printError("Usage: mcx run <alias> [json-input] [--key value ...]");
    d.exit(1);
  }

  const { jsonInput, cliArgs } = parseRunArgs(args.slice(1));

  const aliasInfo = await d.ipcCall("getAlias", { name: aliasName });
  if (!aliasInfo) {
    d.printError(`Alias "${aliasName}" not found`);
    d.exit(1);
  }

  if (!isScopeAllowed(aliasInfo.scope, d.cwd())) {
    d.printError(`Alias "${aliasName}" is scoped to ${aliasInfo.scope} — cannot run from ${d.cwd()}`);
    d.exit(1);
  }

  // Reset TTL on ephemeral aliases when re-run
  if (aliasInfo.expiresAt) {
    const config = d.readCliConfig();
    const ttlMs = config.ephemeralAliases?.ttlMs ?? coreOptions.EPHEMERAL_ALIAS_TTL_MS;
    d.ipcCall("touchAlias", { name: aliasName, expiresAt: Date.now() + ttlMs }).catch(() => {});
  }

  // Record run and maybe suggest promotion (returned for testability)
  const recordPromise = d
    .ipcCall("recordAliasRun", { name: aliasName })
    .then((result) => {
      if (aliasInfo.expiresAt) {
        const config = d.readCliConfig();
        const threshold =
          config.ephemeralAliases?.promotionThreshold ?? coreOptions.EPHEMERAL_ALIAS_PROMOTION_THRESHOLD;
        if (result.runCount >= threshold) {
          d.logError(
            `\u{1F4A1} Used ${result.runCount} times \u2014 promote to permanent: mcx alias promote ${aliasName}`,
          );
        }
      }
    })
    .catch(() => {});

  await d.runAlias(aliasInfo.filePath, cliArgs, jsonInput);

  return { _recordPromise: recordPromise };
}

/**
 * Parse run arguments: extract optional JSON input (first positional arg)
 * and --key value pairs.
 */
export function parseRunArgs(args: string[]): { jsonInput: string | undefined; cliArgs: Record<string, string> } {
  const cliArgs: Record<string, string> = {};
  let jsonInput: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      if (i + 1 < args.length) {
        cliArgs[arg.slice(2)] = args[++i];
      }
      // Orphan flags (no following value) are silently ignored
    } else if (jsonInput === undefined) {
      // First non-flag argument is JSON input
      jsonInput = arg;
    }
  }

  return { jsonInput, cliArgs };
}
