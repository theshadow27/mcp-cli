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
      durationMs: number;
    };

// ── Per-PR run state ──

export interface CiRunState {
  suiteId: number;
  startedAt: number;
  emittedStarted: boolean;
  emittedFinished: boolean;
  lastChecks: Map<string, { status: string; conclusion: string | null }>;
}

// ── Terminal / green helpers ──

const TERMINAL_STATUSES = new Set(["COMPLETED", "CANCELLED", "TIMED_OUT", "STALE", "SKIPPED"]);

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
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
    ? { suiteId, startedAt: now, emittedStarted: false, emittedFinished: false, lastChecks: new Map() }
    : { ...prev, lastChecks: new Map(prev.lastChecks) };

  // Update check snapshot
  for (const c of checks) {
    state.lastChecks.set(c.name, { status: c.status, conclusion: c.conclusion });
  }

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
    const durationMs = now - state.startedAt;
    events.push({ type: "ci.finished", prNumber, workItemId, checks: conclusions, allGreen, durationMs });
    state.emittedFinished = true;
  } else if (!allTerminal && state.emittedStarted && !state.emittedFinished) {
    // ci.running — in between started and finished
    const inProgress = checks.filter((c) => !isTerminal(c.status)).map((c) => c.name);
    const completed = checks.filter((c) => isTerminal(c.status)).map((c) => c.name);
    events.push({ type: "ci.running", prNumber, workItemId, inProgress, completed });
  }

  return { events, state };
}

function resolveSuiteId(checks: readonly CiCheck[]): number | null {
  for (const c of checks) {
    if (c.checkSuiteId !== null) return c.checkSuiteId;
  }
  return null;
}
