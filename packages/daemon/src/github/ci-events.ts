import type { CiCheck } from "./graphql-client";

// ── Event types ──

export interface CiCheckConclusion {
  name: string;
  conclusion: string;
}

export type CiEvent =
  | { type: "ci.started"; prNumber: number; workItemId: string; checks: string[] }
  | { type: "ci.running"; prNumber: number; workItemId: string; inProgress: string[]; completed: string[] }
  | {
      type: "ci.finished";
      prNumber: number;
      workItemId: string;
      checks: CiCheckConclusion[];
      allGreen: boolean;
      observedDurationMs: number;
    };

// ── Per-PR run state ──

export interface CiRunState {
  suiteId: number;
  startedAt: number;
  emittedStarted: boolean;
  emittedFinished: boolean;
}

// ── Terminal / green helpers ──

// GitHub CheckRun status enum only produces "COMPLETED" as a terminal state.
// Conclusions (CANCELLED, TIMED_OUT, STALE, SKIPPED) are separate fields.
function isTerminal(status: string): boolean {
  return status === "COMPLETED";
}

export function isGreenConclusion(conclusion: string): boolean {
  return conclusion === "success" || conclusion === "skipped" || conclusion === "neutral";
}

// ── State machine ──

export function computeCiTransitions(
  prNumber: number,
  workItemId: string,
  prev: CiRunState | null,
  checks: readonly CiCheck[],
  now: number,
): { events: CiEvent[]; state: CiRunState | null } {
  if (checks.length === 0) return { events: [], state: prev };

  const suiteId = resolveSuiteId(checks);
  if (suiteId === null) return { events: [], state: prev };

  const isNewRun = prev === null || prev.suiteId !== suiteId;
  const events: CiEvent[] = [];

  const state: CiRunState = isNewRun
    ? { suiteId, startedAt: now, emittedStarted: false, emittedFinished: false }
    : { ...prev };

  const allTerminal = checks.every((c) => isTerminal(c.status));
  const checkNames = checks.map((c) => c.name);

  // ci.started — once per run
  if (!state.emittedStarted) {
    events.push({ type: "ci.started", prNumber, workItemId, checks: checkNames });
    state.emittedStarted = true;
  }

  if (allTerminal && !state.emittedFinished) {
    // ci.finished — once per run, when all checks reach terminal
    const conclusions: CiCheckConclusion[] = checks.map((c) => ({
      name: c.name,
      conclusion: (c.conclusion ?? "FAILURE").toLowerCase(),
    }));
    const allGreen = conclusions.every((c) => isGreenConclusion(c.conclusion));
    const observedDurationMs = now - state.startedAt;
    events.push({ type: "ci.finished", prNumber, workItemId, checks: conclusions, allGreen, observedDurationMs });
    state.emittedFinished = true;
  } else if (!allTerminal && state.emittedStarted && !state.emittedFinished) {
    // ci.running — in between started and finished
    const inProgress = checks.filter((c) => !isTerminal(c.status)).map((c) => c.name);
    const completed = checks.filter((c) => isTerminal(c.status)).map((c) => c.name);
    events.push({ type: "ci.running", prNumber, workItemId, inProgress, completed });
  }

  return { events, state };
}

// Pick the highest suiteId across all checks. GitHub databaseIds are monotonically
// increasing, so the max correctly identifies the most-recent workflow run even when
// checks from multiple suites (multiple workflow files) appear in the same response.
function resolveSuiteId(checks: readonly CiCheck[]): number | null {
  let max: number | null = null;
  for (const c of checks) {
    if (c.checkSuiteId !== null && (max === null || c.checkSuiteId > max)) {
      max = c.checkSuiteId;
    }
  }
  return max;
}
