/**
 * Compact age formatting for "last used" columns, shared by `mcx ls` and the
 * mcpctl server list.
 *
 * Only the format is shared. Each surface keeps its own cell layout and colour
 * mapping — the ANSI strings the CLI needs and the Ink colour names the TUI
 * needs are different verbs over the same noun.
 */

const MINUTE_S = 60;
const HOUR_S = 60 * MINUTE_S;
const DAY_S = 24 * HOUR_S;
const WEEK_S = 7 * DAY_S;

/**
 * Format elapsed time as `3s` / `5m` / `2h` / `4d` / `6w`.
 *
 * Returns `never` for a missing or zero timestamp: `ServerStatus.lastUsed` is
 * omitted until a server's first call completes, and "never called" is a
 * meaningfully different answer from "called a long time ago".
 *
 * A timestamp in the future clamps to `0s` rather than rendering a negative
 * age — clock skew between a record and the reader should not produce `-3s`.
 */
export function formatAgo(lastUsed: number | undefined | null, now: number = Date.now()): string {
  if (!lastUsed) return "never";
  const secs = Math.max(0, Math.round((now - lastUsed) / 1000));
  if (secs < MINUTE_S) return `${secs}s`;
  if (secs < HOUR_S) return `${Math.floor(secs / MINUTE_S)}m`;
  if (secs < DAY_S) return `${Math.floor(secs / HOUR_S)}h`;
  if (secs < WEEK_S) return `${Math.floor(secs / DAY_S)}d`;
  return `${Math.floor(secs / WEEK_S)}w`;
}

/**
 * Whether a server's connection state is worth showing as live status.
 *
 * HTTP connections are dropped once idle (#3447), so `disconnected` is their
 * normal resting state and reporting it as status is noise. Stdio and virtual
 * servers are child processes that are never idle-reaped, so their state is
 * real information.
 */
export function usesLastUsedStatus(transport: string): boolean {
  return transport === "http";
}
