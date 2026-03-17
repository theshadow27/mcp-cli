/**
 * Ephemeral alias support — auto-save long CLI calls with TTL and auto-expiry.
 */

import { type IpcMethod, type IpcMethodResult, options as coreOptions, readCliConfig } from "@mcp-cli/core";

/**
 * Generate a short ephemeral alias name from server, tool, and args.
 * Format: {tool-prefix}-{4-char-hash}, e.g. "get_-a83r"
 */
export function generateEphemeralName(server: string, tool: string, argsJson: string): string {
  const prefix = tool.slice(0, 4).replace(/[^a-zA-Z0-9_]/g, "");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${server}\0${tool}\0${argsJson}`);
  const hash = hasher.digest("hex").slice(0, 4);
  return `${prefix}-${hash}`;
}

export interface EphemeralDeps {
  ipcCall: <M extends IpcMethod>(method: M, params?: unknown) => Promise<IpcMethodResult[M]>;
  readCliConfig: () => ReturnType<typeof readCliConfig>;
  logError: (msg: string) => void;
}

const defaultDeps: EphemeralDeps = {
  ipcCall: () => {
    throw new Error("ipcCall not injected");
  },
  readCliConfig,
  logError: (msg) => console.error(msg),
};

/**
 * Auto-save a long CLI call as an ephemeral alias (fire-and-forget).
 * Only saves if the serialized args exceed the character threshold.
 */
export function maybeAutoSaveEphemeral(
  server: string,
  tool: string,
  toolArgs: Record<string, unknown>,
  deps?: Partial<EphemeralDeps>,
): void {
  const d = { ...defaultDeps, ...deps };
  const config = d.readCliConfig();
  const ephCfg = config.ephemeralAliases;
  if (ephCfg?.enabled === false) return;

  const argsJson = JSON.stringify(toolArgs);
  const threshold = ephCfg?.charThreshold ?? coreOptions.EPHEMERAL_ALIAS_CHAR_THRESHOLD;
  if (argsJson.length < threshold) return;

  const ttlMs = ephCfg?.ttlMs ?? coreOptions.EPHEMERAL_ALIAS_TTL_MS;
  const name = generateEphemeralName(server, tool, argsJson);
  const expiresAt = Date.now() + ttlMs;

  // Build a minimal freeform script that replays the call
  const script = `const result = await mcp[${JSON.stringify(server)}][${JSON.stringify(tool)}](${argsJson});\nconsole.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));\n`;
  const description = `ephemeral: ${server}/${tool}`;

  // Fire-and-forget — don't block output
  d.ipcCall("saveAlias", { name, script, description, expiresAt }).catch(() => {
    // Silently ignore — ephemeral save is best-effort
  });

  d.logError(`\u{1F4A1} Run again: mcx run ${name} | Edit: mcx alias edit ${name}`);
}
