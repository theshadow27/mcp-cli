/**
 * Ephemeral alias support — auto-save long CLI calls with TTL and auto-expiry.
 */

import { type IpcMethod, type IpcMethodResult, options as coreOptions, readCliConfig } from "@mcp-cli/core";

/**
 * Generate a short ephemeral alias name from server, tool, and args.
 * Format: {tool-prefix}-{8-char-hash}, e.g. "get_-a83rf29b"
 */
export function generateEphemeralName(server: string, tool: string, argsJson: string): string {
  const prefix = tool.slice(0, 4).replace(/[^a-zA-Z0-9_]/g, "");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${server}\0${tool}\0${argsJson}`);
  const hash = hasher.digest("hex").slice(0, 8);
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
 * Auto-save a long CLI call as an ephemeral alias.
 * Only saves if the serialized args exceed the character threshold.
 *
 * The `saveAlias` IPC is awaited and the "Run again" hint is printed **only**
 * after the daemon confirms the save (#2983). The previous fire-and-forget
 * shape printed the hint unconditionally while `process.exit()` in main.ts
 * tore down the event loop before the socket write landed — so the alias the
 * hint named never existed.
 *
 * Callers must await this **after** writing the tool payload to stdout so the
 * extra daemon round-trip does not sit in front of `mcx call`'s output path.
 */
export async function maybeAutoSaveEphemeral(
  server: string,
  tool: string,
  toolArgs: Record<string, unknown>,
  deps?: Partial<EphemeralDeps>,
): Promise<void> {
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

  // Await the save: the hint below promises the alias is runnable, so it must
  // not be printed unless the daemon actually persisted it.
  try {
    const res = await d.ipcCall("saveAlias", { name, script, description, expiresAt });
    // The daemon refuses to shadow an existing permanent alias with an
    // ephemeral one; it answers `{ ok: false, reason }` in that case.
    if (res.ok !== true) {
      d.logError(`[mcx] ephemeral alias "${name}" was not saved`);
      return;
    }
  } catch (err) {
    d.logError(`[mcx] ephemeral alias "${name}" was not saved: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  d.logError(`\u{1F4A1} Run again: mcx run ${name} | Edit: mcx alias edit ${name}`);
}
