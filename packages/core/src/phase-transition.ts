/**
 * Phase transition graph enforcement (issue #1293).
 *
 * Pure validator over an append-only transition log. Given a manifest and the
 * history of transitions for a work item, decides whether a proposed
 * `from → target` move is allowed, and classifies failures into three
 * specific errors instead of one generic "invalid transition":
 *
 *   1. UnknownPhaseError       — target isn't declared (never bypassable)
 *   2. DisallowedTransitionError — target isn't in `phases[from].next`
 *   3. RegressionError         — target already appeared earlier in history
 *
 * `--force <message>` bypasses (2) and (3) but never (1). The message is
 * required (enforced by the caller) and recorded in the log entry so the
 * reasoning is preserved alongside the transition itself.
 *
 * Storage lives in `./transition-store` (SQLite, see #1328/#1372/#1375) and is
 * re-exported here so callers keep a single import site.
 */

import type { Manifest } from "./manifest";
import {
  type OnCorruptLine,
  type TransitionLogEntry,
  appendTransitionLog,
  isCommitted,
  withTransitionWriter,
} from "./transition-store";

export {
  type MigrationReport,
  type OnCorruptLine,
  type OnMigrate,
  type OnWarn,
  type ReadAllOptions,
  type ReadHistoryOptions,
  type StoreOptions,
  type TransitionLogEntry,
  type TransitionStatus,
  type TransitionWriter,
  TransitionLockBusyError,
  appendTransitionLog,
  defaultOnCorruptLine,
  defaultOnMigrate,
  defaultOnWarn,
  isCommitted,
  pruneStaleHistory,
  readAllTransitions,
  readTransitionHistory,
  transitionDbPath,
  withTransitionWriter,
} from "./transition-store";

export class UnknownPhaseError extends Error {
  constructor(
    public readonly target: string,
    public readonly suggestions: string[],
  ) {
    const hint = suggestions.length > 0 ? ` did you mean: ${suggestions.join(", ")}?` : "";
    super(`unknown phase "${target}".${hint}`);
    this.name = "UnknownPhaseError";
  }
}

export class DisallowedTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly target: string,
    public readonly allowed: string[],
    manifestPath = ".mcx.yaml",
  ) {
    const approved = allowed.length > 0 ? allowed.join(", ") : "(none — terminal phase)";
    super(
      `${from} → ${target} is not an approved transition per ${manifestPath}.\napproved from "${from}": ${approved}`,
    );
    this.name = "DisallowedTransitionError";
  }
}

export class RegressionError extends Error {
  constructor(
    public readonly from: string,
    public readonly target: string,
    public readonly workItemId: string | null,
    public readonly history: readonly string[],
  ) {
    const id = workItemId ?? "(none)";
    const trail = history.length > 0 ? history.join(" → ") : "(empty)";
    super(`${from} → ${target} would regress the flow.\nhistory for work item ${id}: ${trail}`);
    this.name = "RegressionError";
  }
}

/** Levenshtein edit distance, iterative two-row variant. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/**
 * Suggest up to 3 phase names close to `target`. Suggestions ranked by edit
 * distance; ties broken alphabetically. Entries with distance > floor(len/2)+1
 * are filtered out to avoid noise on short names.
 */
export function suggestPhases(target: string, known: readonly string[]): string[] {
  const max = Math.floor(target.length / 2) + 1;
  const ranked = known
    .map((name) => ({ name, d: levenshtein(target, name) }))
    .filter((x) => x.d > 0 && x.d <= max)
    .sort((a, b) => a.d - b.d || a.name.localeCompare(b.name));
  return ranked.slice(0, 3).map((x) => x.name);
}

export interface ValidateTransitionInput {
  /** Parsed manifest. */
  manifest: Manifest;
  /** Resolved current phase, or null if this is the first transition. */
  from: string | null;
  /** Proposed target phase. */
  target: string;
  /** Prior targets for this work item, oldest first. */
  history?: readonly string[];
  /** Work-item ID (only used in error text). */
  workItemId?: string | null;
  /** Force escape hatch — bypasses disallowed + regression (never unknown). */
  force?: { message: string } | null;
  /** Manifest path for error messages. */
  manifestPath?: string;
}

/**
 * Validate a proposed transition. Throws one of three typed errors or
 * returns the decision.
 *
 * Check order:
 *   1. Unknown target — never bypassable (misspelled phase has no registered source).
 *   2. Force bypass   — skips all remaining checks, including unknown-from.
 *                       This provides a recovery path when the manifest renames a
 *                       phase mid-sprint and in-flight work items reference the old name.
 *   3. Unknown from   — bypassable via --force (see above).
 *   4. Initial phase  — first transition for a work item must target manifest.initial.
 *   5. Graph walk     — target must be in phases[from].next.
 *                       Declared back-edges (graph cycles) are allowed without --force;
 *                       only moves to phases not reachable from the current phase are
 *                       flagged, using RegressionError when the target was previously
 *                       visited and DisallowedTransitionError otherwise.
 */
export function validateTransition(input: ValidateTransitionInput): {
  from: string | null;
  target: string;
  forced: boolean;
} {
  const { manifest, from, target, history = [], workItemId = null, force = null, manifestPath = ".mcx.yaml" } = input;
  const declared = Object.keys(manifest.phases);

  // Rule 1: unknown target is never bypassable.
  if (!declared.includes(target)) {
    throw new UnknownPhaseError(target, suggestPhases(target, declared));
  }

  // Rule 2: force bypass — skips rules 3-5.
  if (force) {
    return { from, target, forced: true };
  }

  // Rule 2b: idempotent self-loop — a committed `X → X` where the most
  // recent committed target is already `X` is a no-op re-entry, not a
  // regression. Handlers are expected to be idempotent (they self-check
  // state and return "in-flight" when already running), so calling
  // `phase run X` twice in a row must not blow up with RegressionError.
  // See PR #1407 adversarial review.
  if (from !== null && from === target && history.length > 0 && history[history.length - 1] === target) {
    return { from, target, forced: false };
  }

  // Rule 3: unknown from — bypassable via --force above.
  if (from !== null && !declared.includes(from)) {
    throw new UnknownPhaseError(from, suggestPhases(from, declared));
  }

  // Rule 4: initial phase enforcement.
  if (from === null && history.length === 0 && target !== manifest.initial) {
    throw new DisallowedTransitionError("(initial)", target, [manifest.initial], manifestPath);
  }

  // Rule 5: graph walk.
  // Declared back-edges (cycles) are not regressions — they require no --force.
  // Only moves to phases that are not in from.next are errors; within those we
  // distinguish regressions (target already visited) from novel disallowed moves.
  if (from !== null) {
    const allowed = manifest.phases[from]?.next ?? [];
    if (!allowed.includes(target)) {
      if (history.includes(target)) {
        throw new RegressionError(from, target, workItemId, history);
      }
      throw new DisallowedTransitionError(from, target, [...allowed], manifestPath);
    }
  } else if (history.includes(target)) {
    // from === null with a non-empty history: target was already visited.
    throw new RegressionError("(initial)", target, workItemId, history);
  }

  return { from, target, forced: false };
}

/** Return the `to` field of every history entry, oldest first. */
export function historyTargets(entries: readonly TransitionLogEntry[]): string[] {
  return entries.map((e) => e.to);
}

/**
 * Log an "attempted" entry without validation. Unlike `commitTransition`,
 * this never throws on regression / disallowed transitions — the point of
 * an attempt record is to capture intent from any branch or context,
 * including cases that will fail branch-guard or crash during dispatch.
 * Attempted entries are IGNORED by graph-walk and regression checks
 * (see `commitTransition`); they exist purely for audit (#1407).
 */
export function appendAttempt(
  logPath: string,
  input: {
    workItemId: string | null;
    from: string | null;
    target: string;
    forceMessage?: string | null;
    now?: () => Date;
  },
): TransitionLogEntry {
  const ts = (input.now?.() ?? new Date()).toISOString();
  const entry: TransitionLogEntry = {
    ts,
    workItemId: input.workItemId,
    from: input.from,
    to: input.target,
    status: "attempted",
    ...(input.forceMessage ? { forceMessage: input.forceMessage } : {}),
  };
  appendTransitionLog(logPath, entry);
  return entry;
}

export interface CommitTransitionInput {
  manifest: Manifest;
  /** Explicit `from`; if null, inferred from the tail of the history. */
  from: string | null;
  target: string;
  workItemId: string | null;
  force?: { message: string } | null;
  manifestPath?: string;
  /** Timestamp supplier; defaults to `new Date()`. */
  now?: () => Date;
  /** How long to wait for a contended write lock before failing. */
  timeoutMs?: number;
  /** Corrupt-line sink for the one-time legacy jsonl import. */
  onCorrupt?: OnCorruptLine;
}

export interface CommitTransitionResult {
  from: string | null;
  target: string;
  forced: boolean;
  entry: TransitionLogEntry;
}

/**
 * Atomic read-validate-append.
 *
 * The whole cycle runs inside one SQLite write transaction, so two concurrent
 * invocations for the same work item cannot both validate against the same
 * history snapshot and double-append (issue #1328). The second writer blocks on
 * the write lock and then sees the first writer's entry.
 *
 * Callers that only need validation with no side effects should use
 * `validateTransition` directly.
 */
export function commitTransition(logPath: string, input: CommitTransitionInput): CommitTransitionResult {
  const { manifest, target, workItemId, force = null, manifestPath, now, timeoutMs, onCorrupt } = input;

  return withTransitionWriter(
    logPath,
    (writer) => {
      // Validation considers only committed entries; "attempted" entries
      // are audit-only and must not gate future transitions (#1407).
      const history = writer.history(workItemId).filter(isCommitted);
      const targets = historyTargets(history);

      let from = input.from;
      if (from === null && targets.length > 0) {
        from = targets[targets.length - 1];
      }

      const decision = validateTransition({
        manifest,
        from,
        target,
        history: targets,
        workItemId,
        force,
        manifestPath,
      });

      const ts = (now?.() ?? new Date()).toISOString();
      const entry: TransitionLogEntry = {
        ts,
        workItemId,
        from: decision.from,
        to: decision.target,
        status: "committed",
        ...(force ? { forceMessage: force.message } : {}),
      };
      writer.insert(entry);

      return { from: decision.from, target: decision.target, forced: decision.forced, entry };
    },
    { ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(onCorrupt !== undefined ? { onCorrupt } : {}) },
  );
}
