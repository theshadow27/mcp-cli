/**
 * Phase transition graph enforcement (issue #1293).
 *
 * Pure validator + append-only transition log. Given a manifest and the
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
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { Manifest } from "./manifest";

/** One record in the transition log. JSONL on disk. */
export interface TransitionLogEntry {
  /** ISO-8601 UTC timestamp. */
  ts: string;
  /** Work-item identifier, or null if transitioning outside a work item. */
  workItemId: string | null;
  /** Source phase; null for the very first transition (initial). */
  from: string | null;
  /** Target phase (guaranteed to be a declared phase). */
  to: string;
  /** When `--force` was used, the justification text. */
  forceMessage?: string;
}

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

/**
 * Called once per corrupt JSONL line encountered. `lineNumber` is 1-based.
 * Default: warn to stderr so silent log rot is visible (issue #1328).
 */
export type OnCorruptLine = (lineNumber: number, line: string, err: unknown) => void;

function defaultOnCorruptLine(logPath: string): OnCorruptLine {
  return (lineNumber, line, err) => {
    const msg = err instanceof Error ? err.message : String(err);
    const preview = line.length > 80 ? `${line.slice(0, 77)}...` : line;
    process.stderr.write(`warn: corrupt transition log line ${logPath}:${lineNumber} (${msg}): ${preview}\n`);
  };
}

/**
 * Read all transition log entries for a work item from a JSONL file.
 * Missing file → empty array. Malformed lines are passed to `onCorrupt`
 * (default: warn to stderr with line number) so corruption is visible
 * rather than silently swallowed.
 */
export function readTransitionHistory(
  logPath: string,
  workItemId: string | null,
  onCorrupt: OnCorruptLine = defaultOnCorruptLine(logPath),
): TransitionLogEntry[] {
  let text: string;
  try {
    text = readFileSync(logPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const out: TransitionLogEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as TransitionLogEntry;
      if (entry && entry.workItemId === workItemId) out.push(entry);
    } catch (err) {
      onCorrupt(i + 1, line, err);
    }
  }
  return out;
}

/** Return the `to` field of every history entry, oldest first. */
export function historyTargets(entries: readonly TransitionLogEntry[]): string[] {
  return entries.map((e) => e.to);
}

/** Append one transition entry to the JSONL log. Creates parent dir if needed. */
export function appendTransitionLog(logPath: string, entry: TransitionLogEntry): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
}

/**
 * Acquire an exclusive lockfile sidecar for `logPath`, run `fn`, then release.
 *
 * Uses O_EXCL to atomically create `<logPath>.lock`. If contended, polls
 * with jittered backoff up to `timeoutMs`. Stale locks (older than
 * `staleMs`) are reaped to survive crashed holders.
 *
 * Scope: wraps the full read-validate-append cycle so concurrent
 * `mcx phase run` invocations for the same work item can't interleave
 * (issue #1328).
 */
export function withTransitionLock<T>(
  logPath: string,
  fn: () => T,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): T {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const staleMs = opts.staleMs ?? 30_000;
  const lockPath = `${logPath}.lock`;
  mkdirSync(dirname(logPath), { recursive: true });

  // Nonce written into the lock body so we can verify ownership before unlinking.
  // Prevents our finally from deleting a lock acquired by another process if fn()
  // runs longer than staleMs and our lock was reaped while we were inside fn().
  const nonce = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > staleMs) {
          try {
            unlinkSync(lockPath);
          } catch {
            // lost the race; fall through and retry
          }
          continue;
        }
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException)?.code !== "ENOENT") throw statErr;
        // lock disappeared between EEXIST and stat; retry
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `could not acquire transition lock ${lockPath} within ${timeoutMs}ms — another phase run is in progress`,
        );
      }
      const sleep = 10 + Math.floor(Math.random() * 40);
      Bun.sleepSync(sleep);
    }
  }

  // Write nonce so we can verify ownership in finally.
  try {
    writeSync(fd, nonce);
  } catch {
    // write failed; proceed — lock is held but we can't verify in finally
  }

  try {
    const result = fn();
    if (result instanceof Promise) {
      // Lock would be released before the async work completes. Reject loudly.
      throw new Error("withTransitionLock: fn must be synchronous (returned a Promise)");
    }
    return result;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best effort
    }
    // Only unlink if the lock still belongs to us. If fn() took longer than
    // staleMs another process may have reaped our lock and written their nonce.
    try {
      if (readFileSync(lockPath, "utf-8") === nonce) {
        unlinkSync(lockPath);
      }
    } catch {
      // best effort — stale lock will be reaped by the next waiter
    }
  }
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
  /** Lock timeout passthrough. */
  timeoutMs?: number;
  /** Stale-lock reaping threshold passthrough. */
  staleMs?: number;
  /** Corrupt-line sink, passed through to `readTransitionHistory`. */
  onCorrupt?: OnCorruptLine;
}

export interface CommitTransitionResult {
  from: string | null;
  target: string;
  forced: boolean;
  entry: TransitionLogEntry;
}

/**
 * Atomic read-validate-append. Holds an exclusive lock around the full
 * cycle so concurrent invocations can't observe the same history snapshot
 * and double-append (issue #1328).
 *
 * Callers that only need validation with no side effects should use
 * `validateTransition` directly.
 */
export function commitTransition(logPath: string, input: CommitTransitionInput): CommitTransitionResult {
  const { manifest, target, workItemId, force = null, manifestPath, now, timeoutMs, staleMs, onCorrupt } = input;

  return withTransitionLock(
    logPath,
    () => {
      const history = readTransitionHistory(logPath, workItemId, onCorrupt);
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
        ...(force ? { forceMessage: force.message } : {}),
      };
      appendTransitionLog(logPath, entry);

      return { from: decision.from, target: decision.target, forced: decision.forced, entry };
    },
    { timeoutMs, staleMs },
  );
}
