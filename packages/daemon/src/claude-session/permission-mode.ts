/**
 * Resolve the child's `--permission-mode` from the session's PermissionStrategy.
 *
 * Before #3119 these were two unrelated decisions: `buildSpawnCmd` hardcoded
 * `--permission-mode default` while the router separately decided what to do
 * with the `can_use_tool` requests that mode produced. `auto` rubber-stamped
 * every one of them, so a session asking for "auto" got no gate at all — the
 * name predates Claude Code's own auto-mode classifier, so at the time there
 * was nothing to delegate the decision to.
 *
 * There is now. `strategy: "auto"` spawns the child with `--permission-mode
 * auto` and the classifier gates. This module is the single place that decides
 * that, so the flag and the router can never disagree again.
 *
 * ## Why `childGated` is not simply `strategy === "auto"`
 *
 * Verified against claude 2.1.239 (see #3119 for the frame captures): under
 * `--permission-mode auto` the child does **not** round-trip classifier-approved
 * tool calls to `--permission-prompt-tool`. It runs them. A classifier *denial*
 * doesn't round-trip either — it arrives as a `system`/`permission_denied`
 * frame after the fact. So handing the child auto mode moves the gate out of
 * the daemon entirely.
 *
 * That is a straight win for an uncontained session, which had no gate at all.
 * It is a **loss** for a worktree session, whose whole point is ContainmentGuard
 * riding that round-trip (#2805/#3063) — and the classifier is not a substitute:
 * its "Local Operations" rule treats a path the prompt named as cleared user
 * intent, so a worktree worker asked to touch `~/x` gets a clean approve. A
 * probe confirmed exactly that: under auto mode the child wrote to `$HOME` from
 * a cwd outside it without a single frame reaching the daemon.
 *
 * So a contained session keeps the daemon-side gate, and says so out loud
 * (`downgradeReason`) rather than silently doing something other than what the
 * strategy asked for.
 */

import type { PermissionStrategy } from "./permission-router";

/** The `--permission-mode` values this spawn path is allowed to emit. */
export type ClaudePermissionMode = "auto" | "default";

/**
 * Oldest claude version verified to accept `--permission-mode auto`.
 *
 * Set to the oldest binary the #3119 investigation had on hand, not to the
 * version that introduced the mode — which is unknown, and guessing it low
 * would break every `auto` spawn on the binaries in between (commander
 * validates `--permission-mode` against a choice list and exits). Lower it
 * when someone verifies an older binary; the failure direction of being too
 * conservative is just "keeps today's daemon-side gate".
 */
export const MIN_AUTO_MODE_VERSION = "2.1.237";

export interface PermissionModeResolution {
  /** Value to pass to the child's `--permission-mode`. */
  mode: ClaudePermissionMode;
  /**
   * True when the child's auto-mode classifier is the gate and the daemon's
   * router is not consulted for ordinary tool calls. The router reads this to
   * decide what an unexpected `can_use_tool` means — see PermissionRouter.
   */
  childGated: boolean;
  /**
   * Set only when the strategy asked for `auto` and it could not be honoured.
   * Non-null means "the daemon is still the gate"; it is surfaced as a log line
   * and a monitor event so the downgrade is never silent.
   */
  downgradeReason?: string;
}

/**
 * Compare two semver-ish version strings (major.minor.patch).
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((s) => Number.parseInt(s, 10));
  const pb = b.split(".").map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when this binary is known to accept `--permission-mode auto`. */
export function supportsAutoMode(claudeVersion: string | null | undefined): boolean {
  if (!claudeVersion) return false;
  const parsed = claudeVersion.split(".").map((s) => Number.parseInt(s, 10));
  if (parsed.length < 3 || parsed.some((n) => Number.isNaN(n))) return false;
  return compareSemver(claudeVersion, MIN_AUTO_MODE_VERSION) >= 0;
}

/**
 * Decide the child's permission mode and where the gate lives.
 *
 * @param strategy      The session's PermissionStrategy.
 * @param contained     True for worktree sessions (ContainmentGuard is active).
 * @param claudeVersion Resolved claude CLI version, or null when unknown.
 */
export function resolvePermissionMode(opts: {
  strategy: PermissionStrategy;
  contained: boolean;
  claudeVersion: string | null | undefined;
}): PermissionModeResolution {
  // `rules` and `delegate` are daemon-side by construction: both need every
  // tool call to round-trip, which is exactly what auto mode takes away.
  if (opts.strategy !== "auto") return { mode: "default", childGated: false };

  if (opts.contained) {
    return {
      mode: "default",
      childGated: false,
      downgradeReason:
        "worktree session: auto mode would stop can_use_tool reaching the daemon, disabling ContainmentGuard — keeping the daemon-side gate",
    };
  }

  if (!supportsAutoMode(opts.claudeVersion)) {
    return {
      mode: "default",
      childGated: false,
      downgradeReason: `claude ${opts.claudeVersion ?? "version unknown"} is not verified to accept --permission-mode auto (need >= ${MIN_AUTO_MODE_VERSION}) — keeping the daemon-side gate`,
    };
  }

  return { mode: "auto", childGated: true };
}
