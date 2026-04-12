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

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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
 * returns the decision. Unknown target always throws — `--force` cannot
 * bypass rule #1 because a misspelled phase has no registered source.
 */
export function validateTransition(input: ValidateTransitionInput): {
  from: string | null;
  target: string;
  forced: boolean;
} {
  const { manifest, from, target, history = [], workItemId = null, force = null, manifestPath = ".mcx.yaml" } = input;
  const declared = Object.keys(manifest.phases);

  if (!declared.includes(target)) {
    throw new UnknownPhaseError(target, suggestPhases(target, declared));
  }

  if (from !== null && !declared.includes(from)) {
    // `from` is user-provided (via --from or work item state). Suggest for it too.
    throw new UnknownPhaseError(from, suggestPhases(from, declared));
  }

  if (force) {
    return { from, target, forced: true };
  }

  if (from !== null) {
    const allowed = manifest.phases[from]?.next ?? [];
    if (!allowed.includes(target)) {
      throw new DisallowedTransitionError(from, target, [...allowed], manifestPath);
    }
  }

  if (history.includes(target)) {
    throw new RegressionError(from ?? "(initial)", target, workItemId, history);
  }

  return { from, target, forced: false };
}

/**
 * Read all transition log entries for a work item from a JSONL file.
 * Missing file → empty array. Malformed lines are skipped silently to
 * avoid crashing on a corrupted log.
 */
export function readTransitionHistory(logPath: string, workItemId: string | null): TransitionLogEntry[] {
  let text: string;
  try {
    text = readFileSync(logPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const out: TransitionLogEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as TransitionLogEntry;
      if (entry && entry.workItemId === workItemId) out.push(entry);
    } catch {
      // skip corrupt line
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
