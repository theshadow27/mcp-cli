/**
 * Pure logic for aggregating plans from Claude sessions.
 * Extracted from the worker so it can be unit-tested without a real ClaudeWsServer.
 */

import { type Plan, type TranscriptEntry, extractPlansFromTranscript } from "@mcp-cli/core";
import type { AgentSessionState } from "@mcp-cli/core";

/** Session states worth scanning for plan data. */
export const PLAN_LIVE_STATES = new Set<AgentSessionState>(["active", "waiting_permission", "result", "idle"]);

export interface PlanSession {
  sessionId: string;
  state: AgentSessionState;
}

/**
 * Aggregate plans from sessions, filtering to live states and extracting plan data.
 *
 * @param sessions - All sessions to consider
 * @param getTranscript - Callback to fetch transcript for a given sessionId
 * @returns Sorted array of plans (one per live session that has plan data)
 */
export function aggregatePlans(
  sessions: readonly PlanSession[],
  getTranscript: (sessionId: string) => TranscriptEntry[],
): Plan[] {
  const liveSessions = sessions.filter((s) => PLAN_LIVE_STATES.has(s.state));

  const plans: Plan[] = [];
  for (const session of liveSessions) {
    try {
      const transcript = getTranscript(session.sessionId);
      const plan = extractPlansFromTranscript(transcript, session.sessionId);
      if (plan) plans.push(plan);
    } catch (err) {
      console.warn(`[claude_plans] session ${session.sessionId} failed: ${err}`);
    }
  }

  // Sort by id for deterministic ordering
  plans.sort((a, b) => a.id.localeCompare(b.id));
  return plans;
}
