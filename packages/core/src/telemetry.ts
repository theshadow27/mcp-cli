/**
 * Lightweight usage telemetry — fire-and-forget command instrumentation.
 *
 * Sends anonymous command invocation events to PostHog for feature usage analysis.
 * No arguments, content, or PII are collected. See PRIVACY.md for the full schema.
 *
 * Opt-out: set MCX_NO_TELEMETRY=1 or run `mcx telemetry off`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readCliConfig, writeCliConfig } from "./cli-config";
import { VERSION, options } from "./constants";

/** PostHog public project API key — write-only, safe to embed */
const POSTHOG_API_KEY = "phc_mcp_cli_placeholder";

const POSTHOG_ENDPOINT = "https://us.i.posthog.com/capture/";

/** Fetch timeout (ms) — prevents hung DNS/network from holding the process alive */
const FETCH_TIMEOUT_MS = 2_000;

/**
 * Known safe mcx-level subcommands. Only these are recorded as `subcommand`;
 * anything else (which could be a server name or sensitive identifier) is omitted.
 */
const SAFE_SUBCOMMANDS = new Set([
  // telemetry
  "on",
  "off",
  "status",
  // ls / tools
  "ls",
  "list",
  "tools",
  // alias
  "save",
  "show",
  "edit",
  "rm",
  // daemon
  "start",
  "stop",
  "restart",
  "shutdown",
  // claude session management
  "spawn",
  "resume",
  "send",
  "bye",
  "log",
  "wait",
  "interrupt",
  "worktrees",
  // agent providers
  "codex",
  "acp",
  "copilot",
  "gemini",
  "opencode",
  // mail
  "read",
  "send",
  "ls",
  "unread",
  // config subcommands
  "get",
  "set",
  "list",
  // serve
  "kill",
]);

/**
 * Get or create a stable, anonymous device identifier.
 * Generates a random UUID on first call, persists to ~/.mcp-cli/device-id.
 * This is the standard pattern (VS Code, Homebrew) — random, not derived from hostname.
 */
function getOrCreateDeviceId(): string {
  const deviceIdPath = join(options.MCP_CLI_DIR, "device-id");
  try {
    const existing = readFileSync(deviceIdPath, "utf-8").trim();
    if (existing.length > 0) return existing;
  } catch {
    // File doesn't exist — generate below
  }
  const id = crypto.randomUUID();
  try {
    const dir = dirname(deviceIdPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(deviceIdPath, id, "utf-8");
  } catch {
    // Best-effort persist — if we can't write, just use the ephemeral ID
  }
  return id;
}

/** Common CI environment variables — if any are set, we're in CI. */
function isCI(): boolean {
  return !!(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.JENKINS_URL ||
    process.env.BUILDKITE ||
    process.env.CIRCLECI ||
    process.env.GITLAB_CI ||
    process.env.TRAVIS ||
    process.env.TF_BUILD
  );
}

/** Check whether telemetry is disabled via env var, CI, or config. */
export function isTelemetryEnabled(): boolean {
  // Env var takes absolute precedence
  if (process.env.MCX_NO_TELEMETRY === "1") return false;

  // Never send telemetry from CI environments
  if (isCI()) return false;

  // Check config file (telemetry defaults to enabled if unset)
  try {
    const config = readCliConfig();
    if (config.telemetry === false) return false;
  } catch {
    // Can't read config — default to enabled
  }

  return true;
}

/**
 * Check whether the first-run telemetry notice has been shown.
 * Returns true if notice was already shown or just shown now.
 */
export function maybeShowTelemetryNotice(): void {
  try {
    const config = readCliConfig();
    if (config.telemetryNoticeShown) return;

    console.error(
      "Notice: mcx collects anonymous usage telemetry to improve the tool.\n" +
        "No arguments, server names, or personal data are collected.\n" +
        "Opt out anytime: mcx telemetry off  |  export MCX_NO_TELEMETRY=1\n" +
        "Details: PRIVACY.md\n",
    );

    writeCliConfig({ ...config, telemetryNoticeShown: true });
  } catch {
    // Best-effort — never block CLI startup
  }
}

export interface TelemetryDeps {
  enabled: () => boolean;
  fetch: typeof globalThis.fetch;
  machineId: () => string;
  /** Override API key for testing — production code uses the embedded constant */
  apiKey?: string;
}

const defaultDeps: TelemetryDeps = {
  enabled: isTelemetryEnabled,
  fetch: globalThis.fetch,
  machineId: getOrCreateDeviceId,
};

/**
 * Record a command invocation. Fire-and-forget — never throws, never awaits.
 * Returns the fetch promise for testing; callers should NOT await it.
 */
export function recordCommand(
  command: string,
  subcommand?: string,
  deps: TelemetryDeps = defaultDeps,
): Promise<Response | undefined> | undefined {
  const key = deps.apiKey ?? POSTHOG_API_KEY;

  // Build-time guard: if the placeholder key ships, skip silently
  if (key.includes("placeholder")) return undefined;

  if (!deps.enabled()) return undefined;

  // Only record subcommands from the safe allowlist — never leak server names
  const safeSubcommand = subcommand && SAFE_SUBCOMMANDS.has(subcommand) ? subcommand : undefined;

  const body = JSON.stringify({
    api_key: key,
    event: "mcx_command",
    distinct_id: deps.machineId(),
    properties: {
      command,
      ...(safeSubcommand ? { subcommand: safeSubcommand } : {}),
      version: VERSION,
      os: process.platform,
      arch: process.arch,
    },
  });

  return deps
    .fetch(POSTHOG_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    .catch(() => undefined);
}
