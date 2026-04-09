/**
 * Sprint state serialization — enables pause/resume of in-flight sprints.
 *
 * The sprint state file captures which phase each issue is in, session IDs,
 * worktree paths, PR numbers, and costs. This lets a paused sprint be
 * resumed from exactly where it left off.
 *
 * File location: ~/.mcp-cli/sprint-state.json (configurable via options.SPRINT_STATE_PATH)
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentProviderName } from "./agent-session";
import { options } from "./constants";

/** Pipeline phase for a single issue within a sprint. */
export type SprintIssuePhase =
  | "queued"
  | "implementing"
  | "triaging"
  | "reviewing"
  | "repairing"
  | "qa"
  | "merged"
  | "dropped";

/** Per-issue state within a sprint. */
export interface SprintIssueState {
  /** GitHub issue number. */
  issue: number;
  /** Short title (for display). */
  title: string;
  /** Current pipeline phase. */
  phase: SprintIssuePhase;
  /** Scrutiny classification from triage. */
  scrutiny: "low" | "medium" | "high" | null;
  /** Batch number (1-indexed). */
  batch: number;
  /** Agent provider used for implementation. */
  provider: AgentProviderName | null;
  /** Active session ID (null when between phases). */
  sessionId: string | null;
  /** Worktree name (persists across phases for the same issue). */
  worktree: string | null;
  /** PR number once created. */
  prNumber: number | null;
  /** Accumulated cost across all sessions for this issue. */
  cost: number;
  /** ISO timestamp when this issue entered the pipeline. */
  startedAt: string | null;
  /** ISO timestamp when this issue reached a terminal phase (merged/dropped). */
  completedAt: string | null;
}

/** Sprint-level status. */
export type SprintStatus = "running" | "paused" | "completed";

/** Quota snapshot at time of state save. */
export interface QuotaSnapshot {
  /** Utilization percentage (0-100). */
  utilization: number;
  /** ISO timestamp when the quota window resets. */
  resetsAt: string | null;
  /** ISO timestamp when this snapshot was taken. */
  capturedAt: string;
}

/** Top-level sprint state. */
export interface SprintState {
  /** Schema version for forward compatibility. */
  version: 1;
  /** Sprint number. */
  sprint: number;
  /** One-line sprint goal. */
  goal: string;
  /** Current sprint status. */
  status: SprintStatus;
  /** ISO timestamp when the sprint started. */
  startedAt: string;
  /** ISO timestamp when the sprint was paused (null if never paused). */
  pausedAt: string | null;
  /** ISO timestamp when the sprint completed (null if still active). */
  completedAt: string | null;
  /** Per-issue pipeline state. */
  issues: SprintIssueState[];
  /** Most recent quota snapshot (null if never captured). */
  quota: QuotaSnapshot | null;
}

/** Create a fresh issue state with sensible defaults. */
export function createIssueState(
  issue: number,
  title: string,
  batch: number,
  opts?: Partial<Pick<SprintIssueState, "scrutiny" | "provider">>,
): SprintIssueState {
  return {
    issue,
    title,
    phase: "queued",
    scrutiny: opts?.scrutiny ?? null,
    batch,
    provider: opts?.provider ?? null,
    sessionId: null,
    worktree: null,
    prNumber: null,
    cost: 0,
    startedAt: null,
    completedAt: null,
  };
}

/** Create a fresh sprint state. */
export function createSprintState(sprint: number, goal: string, issues: SprintIssueState[]): SprintState {
  return {
    version: 1,
    sprint,
    goal,
    status: "running",
    startedAt: new Date().toISOString(),
    pausedAt: null,
    completedAt: null,
    issues,
    quota: null,
  };
}

/**
 * Return a new SprintState with the given issue's phase and fields updated.
 * Does not mutate the input. Throws if the issue is not found.
 */
export function updateIssuePhase(
  state: SprintState,
  issueNumber: number,
  phase: SprintIssuePhase,
  updates?: Partial<Omit<SprintIssueState, "issue" | "phase">>,
): SprintState {
  const idx = state.issues.findIndex((i) => i.issue === issueNumber);
  if (idx === -1) {
    throw new Error(`Issue #${issueNumber} not found in sprint state`);
  }
  const issue = state.issues[idx];
  const now = new Date().toISOString();
  const isTerminal = phase === "merged" || phase === "dropped";
  const isStarting = issue.phase === "queued" && phase !== "queued";

  const updated: SprintIssueState = {
    ...issue,
    ...updates,
    phase,
    startedAt: isStarting ? (updates?.startedAt ?? now) : issue.startedAt,
    completedAt: isTerminal ? (updates?.completedAt ?? now) : issue.completedAt,
  };

  const issues = [...state.issues];
  issues[idx] = updated;
  return { ...state, issues };
}

/**
 * Read sprint state from the default path (or a custom path).
 * Returns null if the file doesn't exist or is malformed.
 */
export function readSprintState(path?: string): SprintState | null {
  const filePath = path ?? options.SPRINT_STATE_PATH;
  try {
    const text = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(text) as SprintState;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Write sprint state to the default path (or a custom path).
 * Creates parent directories if needed.
 */
export function writeSprintState(state: SprintState, path?: string): void {
  const filePath = path ?? options.SPRINT_STATE_PATH;
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Remove the sprint state file. No-op if it doesn't exist.
 */
export function clearSprintState(path?: string): void {
  const filePath = path ?? options.SPRINT_STATE_PATH;
  try {
    unlinkSync(filePath);
  } catch {
    // File doesn't exist — fine.
  }
}
