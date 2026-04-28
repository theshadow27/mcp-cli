/**
 * `mcx config` commands — display resolved configuration and sources,
 * plus get/set for CLI options like trust-claude, and server config inspection/modification.
 */

import type { BudgetConfig, GetConfigResult, McpConfigFile, ServerConfig } from "@mcp-cli/core";
import { DEFAULT_CLAUDE_WS_PORT, ipcCall, isStdioConfig, readCliConfig, writeCliConfig } from "@mcp-cli/core";
import { c, printError } from "../output";
import { readConfigFile, writeConfigFile } from "./config-file";

// -- Dependency injection for testability --

export interface ConfigDeps {
  getConfig: () => Promise<GetConfigResult>;
  readConfig: (path: string) => McpConfigFile;
  writeConfig: (path: string, config: McpConfigFile) => void;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

const defaultDeps: ConfigDeps = {
  getConfig: () => ipcCall("getConfig"),
  readConfig: readConfigFile,
  writeConfig: writeConfigFile,
};

// -- Entry point --

export async function cmdConfig(args: string[], deps: ConfigDeps = defaultDeps): Promise<void> {
  const sub = args[0] ?? "show";

  switch (sub) {
    case "show":
      await configShow(deps);
      break;
    case "sources":
      await configSources(deps);
      break;
    case "set":
      await configSetDispatch(args.slice(1), deps);
      break;
    case "get":
      await configGetDispatch(args.slice(1), deps);
      break;
    default:
      printError(`Unknown config subcommand: ${sub}. Use "show", "sources", "set", or "get".`);
      process.exit(1);
  }
}

async function configShow(deps: ConfigDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const config = await deps.getConfig();
  const entries = Object.entries(config.servers);

  if (entries.length === 0) {
    error("No servers configured.");
    return;
  }

  const maxName = Math.max(...entries.map(([n]) => n.length));

  for (const [name, info] of entries) {
    log(
      `  ${c.cyan}${name.padEnd(maxName)}${c.reset}  ${c.dim}${info.transport.padEnd(6)}${c.reset}  ${info.toolCount > 0 ? `${info.toolCount} tools` : ""}  ${c.dim}${info.scope}:${info.source}${c.reset}`,
    );
  }
  log(`\n${entries.length} server(s) from ${config.sources.length} source(s)`);
}

async function configSources(deps: ConfigDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const config = await deps.getConfig();

  if (config.sources.length === 0) {
    error("No config sources found.");
    return;
  }

  log(`${c.bold}Config sources${c.reset} (highest priority last):\n`);
  for (const source of config.sources) {
    log(`  ${c.yellow}${source.scope.padEnd(10)}${c.reset}  ${source.file}`);
  }
}

// -- CLI option keys --

const VALID_KEYS = ["trust-claude", "terminal", "ws-port"] as const;
type ConfigKey = (typeof VALID_KEYS)[number];

const KEY_MAP: Record<ConfigKey, "trustClaude" | "terminal" | "wsPort"> = {
  "trust-claude": "trustClaude",
  terminal: "terminal",
  "ws-port": "wsPort",
};

/** Keys whose values are stored as booleans (vs strings) */
const BOOLEAN_KEYS = new Set<ConfigKey>(["trust-claude"]);

/** Keys whose values are stored as numbers */
const NUMBER_KEYS = new Set<ConfigKey>(["ws-port"]);

/** Check if a key is a known CLI option (vs a server name). */
export function isCliOptionKey(key: string): boolean {
  return VALID_KEYS.includes(key as ConfigKey);
}

// -- Dispatch: CLI option vs server config --

export async function configGetDispatch(args: string[], deps: ConfigDeps = defaultDeps): Promise<void> {
  const key = args.find((a) => !a.startsWith("-"));
  if (!key) {
    printError("Usage: mcx config get <key|server> [--show-secrets] [--json]");
    process.exit(1);
  }

  if (isCliOptionKey(key)) {
    configGetCliOption(args, deps.log);
    return;
  }

  if (isBudgetKey(key)) {
    await configGetBudget(key, deps.log);
    return;
  }

  await configGetServer(args, deps);
}

export async function configSetDispatch(args: string[], deps: ConfigDeps = defaultDeps): Promise<void> {
  const [first, second] = args;
  if (!first) {
    printError(
      "Usage: mcx config set <key> <value>\n       mcx config set <server> env <KEY>:<VALUE>\n       mcx config set <server> url <new-url>\n       mcx config set <server> args <arg1> [arg2...]",
    );
    process.exit(1);
  }

  if (second === "env") {
    await configSetServerEnv(args, deps);
    return;
  }

  if (second === "url") {
    await configSetServerUrl(args, deps);
    return;
  }

  if (second === "args") {
    await configSetServerArgs(args, deps);
    return;
  }

  if (isBudgetKey(first)) {
    await configSetBudget(first, second, deps.log);
    return;
  }

  configSetCliOption(args, deps.log);
}

// -- CLI option get/set --

function configSetCliOption(args: string[], log?: (msg: string) => void): void {
  const [key, value] = args;
  if (!key || value === undefined) {
    printError("Usage: mcx config set <key> <value>");
    process.exit(1);
  }
  if (!isCliOptionKey(key)) {
    printError(`Unknown config key: ${key}. Valid keys: ${VALID_KEYS.join(", ")}`);
    process.exit(1);
  }
  const prop = KEY_MAP[key as ConfigKey];
  const config = readCliConfig();
  if (BOOLEAN_KEYS.has(key as ConfigKey)) {
    (config as Record<string, unknown>)[prop] = value === "true";
  } else if (NUMBER_KEYS.has(key as ConfigKey)) {
    const num = Number(value);
    if (Number.isNaN(num) || !Number.isInteger(num) || num < 0 || num > 65535) {
      printError(`Invalid value for ${key}: must be an integer in [0, 65535]`);
      process.exit(1);
    }
    (config as Record<string, unknown>)[prop] = num;
  } else {
    (config as Record<string, unknown>)[prop] = value;
  }
  writeCliConfig(config);
  (log ?? console.log)(`${key} = ${config[prop]}`);
}

function configGetCliOption(args: string[], log?: (msg: string) => void): void {
  const key = args[0];
  if (!key) {
    printError("Usage: mcx config get <key>");
    process.exit(1);
  }
  if (!isCliOptionKey(key)) {
    printError(`Unknown config key: ${key}. Valid keys: ${VALID_KEYS.join(", ")}`);
    process.exit(1);
  }
  const prop = KEY_MAP[key as ConfigKey];
  const config = readCliConfig();
  const defaultValue = BOOLEAN_KEYS.has(key as ConfigKey)
    ? false
    : NUMBER_KEYS.has(key as ConfigKey)
      ? String(DEFAULT_CLAUDE_WS_PORT)
      : "";
  (log ?? console.log)(String(config[prop] ?? defaultValue));
}

// -- Server config get/set --

export async function configGetServer(args: string[], deps: ConfigDeps = defaultDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const showSecrets = args.includes("--show-secrets");
  const json = args.includes("--json") || args.includes("-j");
  const name = args.find((a) => !a.startsWith("-"));

  if (!name) {
    printError("Usage: mcx config get <server> [--show-secrets] [--json]");
    process.exit(1);
  }

  const result = await deps.getConfig();
  const serverMeta = result.servers[name];
  if (!serverMeta) {
    printError(`Server "${name}" not found`);
    process.exit(1);
  }

  const fileConfig = deps.readConfig(serverMeta.source);
  const serverConfig = fileConfig.mcpServers?.[name];

  if (json) {
    log(
      JSON.stringify(
        {
          name,
          transport: serverMeta.transport,
          source: serverMeta.source,
          scope: serverMeta.scope,
          config: serverConfig ? maskConfig(serverConfig, showSecrets) : null,
        },
        null,
        2,
      ),
    );
    return;
  }

  log(`${c.cyan}${name}${c.reset} ${c.dim}(${serverMeta.transport})${c.reset}`);

  if (serverConfig) {
    printServerConfigDetails(serverConfig, showSecrets, deps.log);
  }

  log(`  ${c.bold}source${c.reset}: ${serverMeta.source} ${c.dim}(${serverMeta.scope})${c.reset}`);
}

export function printServerConfigDetails(
  config: ServerConfig,
  showSecrets: boolean,
  log?: (msg: string) => void,
): void {
  const out = log ?? console.log;
  if (isStdioConfig(config)) {
    const cmdLine = [config.command, ...(config.args ?? [])].join(" ");
    out(`  ${c.bold}command${c.reset}: ${cmdLine}`);
    if (config.cwd) {
      out(`  ${c.bold}cwd${c.reset}: ${config.cwd}`);
    }
    if (config.env && Object.keys(config.env).length > 0) {
      out(`  ${c.bold}env${c.reset}:`);
      for (const [k, v] of Object.entries(config.env)) {
        out(`    ${k}: ${showSecrets ? v : maskValue(v)}`);
      }
    }
  } else {
    out(`  ${c.bold}url${c.reset}: ${config.url}`);
    if (config.headers && Object.keys(config.headers).length > 0) {
      out(`  ${c.bold}headers${c.reset}:`);
      for (const [k, v] of Object.entries(config.headers)) {
        out(`    ${k}: ${showSecrets ? v : maskValue(v)}`);
      }
    }
  }
}

/** Parse KEY:VALUE string. Returns null on invalid format. */
export function parseEnvKeyValue(input: string): { key: string; value: string } | null {
  const colonIdx = input.indexOf(":");
  if (colonIdx < 1) return null;
  return { key: input.slice(0, colonIdx), value: input.slice(colonIdx + 1) };
}

export async function configSetServerEnv(args: string[], deps: ConfigDeps = defaultDeps): Promise<void> {
  const serverName = args[0];
  const keyValue = args[2];

  if (!serverName || !keyValue) {
    printError("Usage: mcx config set <server> env <KEY>:<VALUE>");
    process.exit(1);
  }

  const parsed = parseEnvKeyValue(keyValue);
  if (!parsed) {
    printError("Invalid format. Use <KEY>:<VALUE> (e.g. API_KEY:sk-xxx)");
    process.exit(1);
  }

  const { key, value } = parsed;

  const result = await deps.getConfig();
  const serverMeta = result.servers[serverName];
  if (!serverMeta) {
    printError(`Server "${serverName}" not found`);
    process.exit(1);
  }

  const fileConfig = deps.readConfig(serverMeta.source);
  const serverConfig = fileConfig.mcpServers?.[serverName];
  if (!serverConfig) {
    printError(`Server "${serverName}" not found in ${serverMeta.source}`);
    process.exit(1);
  }

  if (!isStdioConfig(serverConfig)) {
    printError(
      `Server "${serverName}" uses ${serverConfig.type} transport. Environment variables are only supported for stdio servers.`,
    );
    process.exit(1);
  }

  serverConfig.env = serverConfig.env ?? {};
  serverConfig.env[key] = value;
  deps.writeConfig(serverMeta.source, fileConfig);

  (deps.log ?? console.log)(`Set ${key} on ${serverName}`);
}

export async function configSetServerUrl(args: string[], deps: ConfigDeps = defaultDeps): Promise<void> {
  const serverName = args[0];
  const newUrl = args[2];

  if (!serverName || !newUrl) {
    printError("Usage: mcx config set <server> url <new-url>");
    process.exit(1);
  }

  const result = await deps.getConfig();
  const serverMeta = result.servers[serverName];
  if (!serverMeta) {
    printError(`Server "${serverName}" not found`);
    process.exit(1);
  }

  const fileConfig = deps.readConfig(serverMeta.source);
  const serverConfig = fileConfig.mcpServers?.[serverName];
  if (!serverConfig) {
    printError(`Server "${serverName}" not found in ${serverMeta.source}`);
    process.exit(1);
  }

  if (isStdioConfig(serverConfig)) {
    printError(`Server "${serverName}" uses stdio transport. The url field is only supported for http/sse servers.`);
    process.exit(1);
  }

  serverConfig.url = newUrl;
  deps.writeConfig(serverMeta.source, fileConfig);

  (deps.log ?? console.log)(`Set url on ${serverName}`);
}

export async function configSetServerArgs(args: string[], deps: ConfigDeps = defaultDeps): Promise<void> {
  const serverName = args[0];
  const newArgs = args.slice(2);

  if (!serverName || newArgs.length === 0) {
    printError("Usage: mcx config set <server> args <arg1> [arg2...]");
    process.exit(1);
  }

  const result = await deps.getConfig();
  const serverMeta = result.servers[serverName];
  if (!serverMeta) {
    printError(`Server "${serverName}" not found`);
    process.exit(1);
  }

  const fileConfig = deps.readConfig(serverMeta.source);
  const serverConfig = fileConfig.mcpServers?.[serverName];
  if (!serverConfig) {
    printError(`Server "${serverName}" not found in ${serverMeta.source}`);
    process.exit(1);
  }

  if (!isStdioConfig(serverConfig)) {
    printError(
      `Server "${serverName}" uses ${serverConfig.type} transport. The args field is only supported for stdio servers.`,
    );
    process.exit(1);
  }

  serverConfig.args = newArgs;
  deps.writeConfig(serverMeta.source, fileConfig);

  (deps.log ?? console.log)(`Set args on ${serverName}`);
}

// -- Masking --

/**
 * Mask a sensitive value for display.
 * Preserves ${VAR} env references as-is (they're not secrets).
 */
export function maskValue(value: string): string {
  if (/^\$\{[^}]+\}$/.test(value)) return value;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-3)}`;
}

// -- Budget config (#1587) --

const BUDGET_KEYS: Record<string, keyof BudgetConfig> = {
  "budget.session-cap": "sessionCap",
  "budget.sprint-cap": "sprintCap",
  "budget.sprint-window-hours": "sprintWindowMs",
  "budget.quota-thresholds": "quotaThresholds",
  "budget.quota-deadband": "quotaDeadband",
};

export function isBudgetKey(key: string): boolean {
  return key in BUDGET_KEYS;
}

export { BUDGET_KEYS };

export interface BudgetIpc {
  get: () => Promise<BudgetConfig>;
  set: (partial: Partial<BudgetConfig>) => Promise<{ ok: true }>;
}

const defaultBudgetIpc: BudgetIpc = {
  get: () => ipcCall("getBudgetConfig"),
  set: (partial) => ipcCall("setBudgetConfig", partial),
};

export async function configGetBudget(
  key: string,
  log?: (msg: string) => void,
  ipc: BudgetIpc = defaultBudgetIpc,
): Promise<void> {
  const prop = BUDGET_KEYS[key];
  if (!prop) {
    printError(`Unknown budget key: ${key}. Valid keys: ${Object.keys(BUDGET_KEYS).join(", ")}`);
    process.exit(1);
  }
  const config = await ipc.get();
  let value: number | number[] = config[prop];
  if (prop === "sprintWindowMs") {
    value = (value as number) / (60 * 60 * 1000);
  }
  (log ?? console.log)(Array.isArray(value) ? JSON.stringify(value) : String(value));
}

export async function configSetBudget(
  key: string,
  rawValue: string | undefined,
  log?: (msg: string) => void,
  ipc: BudgetIpc = defaultBudgetIpc,
): Promise<void> {
  const prop = BUDGET_KEYS[key];
  if (!prop) {
    printError(`Unknown budget key: ${key}. Valid keys: ${Object.keys(BUDGET_KEYS).join(", ")}`);
    process.exit(1);
  }
  if (rawValue === undefined) {
    printError(`Usage: mcx config set ${key} <value>`);
    process.exit(1);
  }

  const partial: Partial<BudgetConfig> = {};

  if (prop === "quotaThresholds") {
    const thresholds = rawValue.split(",").map(Number);
    if (thresholds.some((n) => Number.isNaN(n) || n < 0 || n > 100)) {
      printError("Quota thresholds must be comma-separated numbers between 0 and 100");
      process.exit(1);
    }
    partial.quotaThresholds = thresholds;
  } else if (prop === "sprintWindowMs") {
    const hours = Number(rawValue);
    if (Number.isNaN(hours) || hours <= 0) {
      printError("Sprint window must be a positive number of hours");
      process.exit(1);
    }
    partial.sprintWindowMs = hours * 60 * 60 * 1000;
  } else {
    const num = Number(rawValue);
    if (Number.isNaN(num) || num < 0) {
      printError(`${key} must be a non-negative number`);
      process.exit(1);
    }
    (partial as Record<string, number>)[prop] = num;
  }

  await ipc.set(partial);
  (log ?? console.log)(`${key} = ${rawValue}`);
}

// -- Masking --

/** Return a config object with sensitive values masked (for JSON output). */
export function maskConfig(config: ServerConfig, showSecrets: boolean): ServerConfig {
  if (showSecrets) return config;

  if (isStdioConfig(config)) {
    if (!config.env) return config;
    const maskedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(config.env)) {
      maskedEnv[k] = maskValue(v);
    }
    return { ...config, env: maskedEnv };
  }

  const httpConfig = config as { headers?: Record<string, string> };
  if (!httpConfig.headers) return config;
  const maskedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(httpConfig.headers)) {
    maskedHeaders[k] = maskValue(v);
  }
  return { ...config, headers: maskedHeaders };
}
