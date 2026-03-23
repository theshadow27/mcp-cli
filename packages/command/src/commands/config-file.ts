/**
 * Config file read/write helpers for `mcx add`, `mcx remove`.
 *
 * Re-exports from @mcp-cli/core where the canonical implementation lives.
 * The daemon's ConfigWatcher picks up changes automatically — no IPC needed.
 */

export {
  type ConfigScope,
  CONFIG_SCOPES,
  CONFIG_SCOPES_NO_LOCAL,
  resolveConfigPath,
  readConfigFile,
  writeConfigFile,
  addServerToConfig,
  removeServerFromConfig,
} from "@mcp-cli/core";
