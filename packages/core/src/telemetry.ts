/**
 * Lightweight usage telemetry — fire-and-forget command instrumentation.
 *
 * Sends anonymous command invocation events to PostHog for feature usage analysis.
 * No arguments, content, or PII are collected. See PRIVACY.md for the full schema.
 *
 * Opt-out: set MCX_NO_TELEMETRY=1 or run `mcx telemetry off`.
 */

import { hostname } from "node:os";
import { readCliConfig } from "./cli-config";
import { VERSION } from "./constants";

/** PostHog public project API key — write-only, safe to embed */
const POSTHOG_API_KEY = "phc_mcp_cli_placeholder";

const POSTHOG_ENDPOINT = "https://us.i.posthog.com/capture/";

/**
 * Generate a stable, anonymous machine identifier.
 * SHA-256 hash of hostname — no PII, but stable across invocations.
 */
function getMachineId(): string {
  const raw = hostname();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(raw);
  return hasher.digest("hex").slice(0, 16);
}

/** Check whether telemetry is disabled via env var or config. */
export function isTelemetryEnabled(): boolean {
  // Env var takes absolute precedence
  if (process.env.MCX_NO_TELEMETRY === "1") return false;

  // Check config file (telemetry defaults to enabled if unset)
  try {
    const config = readCliConfig();
    if (config.telemetry === false) return false;
  } catch {
    // Can't read config — default to enabled
  }

  return true;
}

export interface TelemetryDeps {
  enabled: () => boolean;
  fetch: typeof globalThis.fetch;
  machineId: () => string;
}

const defaultDeps: TelemetryDeps = {
  enabled: isTelemetryEnabled,
  fetch: globalThis.fetch,
  machineId: getMachineId,
};

/**
 * Record a command invocation. Fire-and-forget — never throws, never awaits.
 * Returns the fetch promise for testing; callers should NOT await it.
 */
export function recordCommand(
  command: string,
  subcommand?: string,
  deps: TelemetryDeps = defaultDeps,
): Promise<Response> | undefined {
  if (!deps.enabled()) return undefined;

  const body = JSON.stringify({
    api_key: POSTHOG_API_KEY,
    event: "mcx_command",
    distinct_id: deps.machineId(),
    properties: {
      command,
      ...(subcommand ? { subcommand } : {}),
      version: VERSION,
      os: process.platform,
      arch: process.arch,
    },
  });

  // Fire-and-forget: catch errors silently, never delay CLI
  return deps
    .fetch(POSTHOG_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })
    .catch(() => undefined as unknown as Response);
}
