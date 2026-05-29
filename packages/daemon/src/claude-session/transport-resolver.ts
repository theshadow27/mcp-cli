/**
 * Resolve the transport mode for a Claude CLI session.
 *
 * Given the user's config preference and the resolved claude version,
 * determines whether to use the stdio pipe transport or the legacy
 * sdk-url WebSocket transport.
 *
 * Version gate: ≤2.1.122 → "ws" (sdk-url + patcher), >2.1.122 → "stdio".
 */

import type { ClaudeTransport } from "@mcp-cli/core";

/** Resolved per-session transport. */
export type SessionTransport = "ws" | "stdio";

/** Version at or below which the sdk-url WS transport is required. */
const LAST_SDK_URL_VERSION = "2.1.122";

/**
 * Compare two semver-ish version strings (major.minor.patch).
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((s) => Number.parseInt(s, 10));
  const pb = b.split(".").map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Resolve the transport for a session spawn.
 *
 * @param configTransport User's `~/.mcp-cli/config.json` `transport` setting.
 * @param claudeVersion   Resolved Claude CLI version string (e.g. "2.1.123").
 *                        When null (version unknown), defaults to "ws" for safety.
 */
export function resolveTransport(
  configTransport: ClaudeTransport | undefined,
  claudeVersion: string | null,
): SessionTransport {
  const pref = configTransport ?? "auto";

  if (pref === "stdio") return "stdio";
  if (pref === "sdk-url") return "ws";

  // "auto" — version-gated
  if (!claudeVersion) return "ws";
  return compareSemver(claudeVersion, LAST_SDK_URL_VERSION) > 0 ? "stdio" : "ws";
}
