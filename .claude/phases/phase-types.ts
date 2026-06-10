/** Shared types used across phase fn files. */

export interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ParsedPrEditFlags {
  addLabels: string[];
  removeLabels: string[];
}

export function parsePrEditFlags(flags: string[]): ParsedPrEditFlags {
  const addLabels: string[] = [];
  const removeLabels: string[] = [];
  for (let i = 0; i < flags.length; i += 2) {
    if (flags[i] === "--add-label") addLabels.push(flags[i + 1]);
    else if (flags[i] === "--remove-label") removeLabels.push(flags[i + 1]);
    else throw new Error(`prEdit: unknown flag ${flags[i]}`);
  }
  return { addLabels, removeLabels };
}

/**
 * Typed GH operations for the gh() dependency injection point.
 * Each variant maps to a specific ctx.gh method call; adapters dispatch on op.op.
 * stdout format per op:
 *   pr:labels        — newline-separated label names
 *   pr:checks        — decimal count of non-SUCCESS checks
 *   pr:comments      — concatenated comment bodies (newline-joined)
 *   pr:label-events  — JSON array of GhLabelEvent[]
 *   pr:head-date     — ISO 8601 committer date of the PR head commit
 *   pr:author        — GitHub login of the PR author
 */
export type GhOp =
  | { op: "pr:labels"; prNumber: number }
  | { op: "pr:checks"; prNumber: number }
  | { op: "pr:comments"; prNumber: number }
  | { op: "pr:label-events"; prNumber: number }
  | { op: "pr:head-date"; prNumber: number }
  | { op: "pr:author"; prNumber: number };

export interface GhLabelEvent {
  actor: string;
  label: string;
  created_at: string;
}

export interface VerdictContext {
  prAuthor: string;
  roundStartedAt: number;
  headCommitDate: string;
}

/**
 * Validate a verdict label against freshness, head-commit, and actor guards.
 * Returns { valid: true } or { valid: false, rejection: <reason> }.
 *
 * Guards (evaluated in order):
 *   (b) Freshness — label event must postdate the session spawn time.
 *   (c) Head commit — label event must postdate the PR head commit's committer date.
 *       Catches pre-planted labels and post-verdict code tampering (#2609 shape).
 *   (a) Actor — compares label actor to PR author. **Inert under single-identity
 *       deployments** where every session (implementer, reviewer, QA) acts as the
 *       same GitHub login. The guard is scaffolding for future multi-identity setups;
 *       it logs but does not reject, so it carries zero security weight today.
 *
 * Fail-closed: if no matching labeled event is found, or any timestamp is
 * unparseable, the verdict is treated as absent.
 */
export function validateVerdictLabel(
  label: string,
  events: GhLabelEvent[],
  ctx: VerdictContext,
): { valid: true; actorNote?: string } | { valid: false; rejection: string } {
  if (Number.isNaN(ctx.roundStartedAt)) {
    return { valid: false, rejection: `roundStartedAt is NaN — fail closed` };
  }

  const matching = events
    .filter((e) => e.label === label)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  if (matching.length === 0) {
    return { valid: false, rejection: `no labeled event found for ${label} — fail closed` };
  }

  const event = matching[0];
  const eventTime = new Date(event.created_at).getTime();
  if (Number.isNaN(eventTime)) {
    return { valid: false, rejection: `unparseable timestamp on ${label} event (${event.created_at}) — fail closed` };
  }

  // Guard (b): freshness — must postdate session spawn.
  // Uses `<` (not `<=`): a label timestamped at the exact spawn instant is accepted
  // as borderline-fresh. Guard (c) below uses `<=` (strictly after) because a label
  // at the exact committer-date second could be pre-planted before the push propagated.
  // Known limitation: roundStartedAt is Date.now() (local clock) while event.created_at
  // is a GitHub server timestamp. Clock skew can cause false rejections; the failure
  // mode is fail-closed (verdict treated as absent), which is the preferred direction.
  if (eventTime < ctx.roundStartedAt) {
    return {
      valid: false,
      rejection: `${label} event (${event.created_at}) predates session spawn (${new Date(ctx.roundStartedAt).toISOString()}) — stale verdict`,
    };
  }

  // Guard (c): must postdate PR head commit
  const headTime = new Date(ctx.headCommitDate).getTime();
  if (Number.isNaN(headTime)) {
    return { valid: false, rejection: `unparseable head commit date (${ctx.headCommitDate}) — fail closed` };
  }
  if (eventTime <= headTime) {
    return {
      valid: false,
      rejection: `${label} event (${event.created_at}) predates head commit (${ctx.headCommitDate}) — verdict on stale code`,
    };
  }

  // Guard (a): actor check — inert under single-identity deployments.
  // In this deployment every session (implementer, reviewer, QA) shares the same
  // GitHub login, so actor == prAuthor is the EXPECTED case for legitimate verdicts.
  // Enforcing "actor ≠ prAuthor" would block every valid verdict. This guard exists
  // as scaffolding for future multi-identity setups; it logs but never rejects.
  const actorNote =
    event.actor === ctx.prAuthor
      ? `actor (${event.actor}) matches PR author — expected under single-identity; would be a self-approval concern under multi-identity`
      : undefined;

  return { valid: true, actorNote };
}
