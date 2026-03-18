/**
 * Claude Code plan adapter — converts Claude session transcript data
 * into the Plan data model for display in the Plans tab.
 *
 * Two extraction strategies:
 * 1. TodoWrite tool_use blocks (structured) — most reliable
 * 2. Markdown text with headings + checkboxes — fallback for plan-mode output
 */

import type { Plan, PlanStatus, PlanStep } from "@mcp-cli/core";
import { z } from "zod/v4";

/** Zod schema for transcript entries from the daemon's NDJSON ring buffer. */
const TranscriptEntrySchema = z.object({
  timestamp: z.number(),
  direction: z.enum(["inbound", "outbound"]),
  message: z.record(z.string(), z.unknown()),
});

/** Transcript entry shape from the daemon's NDJSON ring buffer. */
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

/**
 * Validate and filter raw parsed JSON into TranscriptEntry[].
 * Invalid entries are skipped with a warning logged to console.error.
 */
export function validateTranscriptEntries(raw: unknown, sessionId: string): TranscriptEntry[] {
  if (!Array.isArray(raw)) {
    console.error(`[claude-plan-adapter] session ${sessionId}: expected array, got ${typeof raw}`);
    return [];
  }

  const valid: TranscriptEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const result = TranscriptEntrySchema.safeParse(raw[i]);
    if (result.success) {
      valid.push(result.data);
    } else {
      console.error(`[claude-plan-adapter] session ${sessionId}: skipping entry[${i}]: ${result.error.message}`);
    }
  }
  return valid;
}

/** A single todo item from Claude Code's TodoWrite tool input. */
interface TodoItem {
  id: string;
  content: string;
  status: "completed" | "in_progress" | "pending";
  priority?: "high" | "medium" | "low";
}

// ── TodoWrite extraction ──

/**
 * Extract the latest TodoWrite todos from transcript entries.
 * Scans assistant messages for tool_use blocks with name "TodoWrite".
 * Returns the last (most recent) TodoWrite input, or null.
 */
export function extractTodosFromTranscript(entries: ReadonlyArray<TranscriptEntry>): TodoItem[] | null {
  let lastTodos: TodoItem[] | null = null;

  for (const entry of entries) {
    if (entry.direction !== "inbound") continue;
    const msg = entry.message;
    if (msg.type !== "assistant" || !msg.message) continue;

    const inner = msg.message as Record<string, unknown>;
    const content = inner.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_use" || b.name !== "TodoWrite") continue;

      const input = b.input as Record<string, unknown> | undefined;
      if (!input || !Array.isArray(input.todos)) continue;

      const todos = input.todos as TodoItem[];
      if (todos.length > 0) {
        lastTodos = todos;
      }
    }
  }

  return lastTodos;
}

/**
 * Convert TodoWrite items into a Plan.
 */
export function todosToPlan(todos: TodoItem[], sessionId: string): Plan {
  const steps: PlanStep[] = todos.map((todo) => ({
    id: todo.id,
    name: todo.content,
    status: todoStatusToPlanStatus(todo.status),
  }));

  const activeStep = steps.find((s) => s.status === "active");
  const allComplete = steps.every((s) => s.status === "complete");
  const anyActive = steps.some((s) => s.status === "active");

  let planStatus: PlanStatus;
  if (allComplete) planStatus = "complete";
  else if (anyActive) planStatus = "active";
  else planStatus = "pending";

  return {
    id: `claude-${sessionId}`,
    name: `Session ${sessionId.slice(0, 8)}`,
    status: planStatus,
    server: "_claude",
    steps,
    activeStepId: activeStep?.id,
  };
}

function todoStatusToPlanStatus(status: TodoItem["status"]): PlanStatus {
  switch (status) {
    case "completed":
      return "complete";
    case "in_progress":
      return "active";
    case "pending":
      return "pending";
  }
}

// ── Markdown plan parsing ──

interface ParsedPhase {
  name: string;
  tasks: Array<{ text: string; checked: boolean }>;
}

/**
 * Parse Claude plan markdown into the Plan data model.
 *
 * Expected format:
 * ```
 * ## Phase 1: Setup
 * - [x] Task one
 * - [ ] Task two
 *
 * ## Phase 2: Implementation
 * - [ ] Task three
 * ```
 *
 * Headings (##) become steps. Checkbox completion determines step status.
 */
export function parseClaudePlanMarkdown(markdown: string, planId: string, sessionId: string): Plan | null {
  const phases = parsePhases(markdown);
  if (phases.length === 0) return null;

  const steps: PlanStep[] = phases.map((phase, index) => {
    const done = phase.tasks.filter((t) => t.checked).length;

    let status: PlanStatus;
    if (done === phase.tasks.length) status = "complete";
    else if (done > 0) status = "active";
    else status = "pending";

    return {
      id: `phase-${index}`,
      name: phase.name,
      status,
    };
  });

  const activeStep = steps.find((s) => s.status === "active");
  const allComplete = steps.every((s) => s.status === "complete");
  const anyActive = steps.some((s) => s.status === "active");

  let planStatus: PlanStatus;
  if (allComplete) planStatus = "complete";
  else if (anyActive) planStatus = "active";
  else planStatus = "pending";

  return {
    id: planId,
    name: `Session ${sessionId.slice(0, 8)}`,
    status: planStatus,
    server: "_claude",
    steps,
    activeStepId: activeStep?.id,
  };
}

/** Parse markdown into phases (heading + checkbox groups). */
function parsePhases(markdown: string): ParsedPhase[] {
  const lines = markdown.split("\n");
  const phases: ParsedPhase[] = [];
  let current: ParsedPhase | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      current = { name: headingMatch[1].trim(), tasks: [] };
      phases.push(current);
      continue;
    }

    const checkboxMatch = line.match(/^[\s]*[-*]\s+\[([ xX])\]\s+(.*)/);
    if (checkboxMatch && current) {
      current.tasks.push({
        checked: checkboxMatch[1] !== " ",
        text: checkboxMatch[2].trim(),
      });
    }
  }

  // Only return phases that have at least one checkbox task
  return phases.filter((p) => p.tasks.length > 0);
}

/**
 * Check if a markdown string looks like a plan.
 * Requires headings with plan-like keywords (phase, step, task, stage)
 * or at least 2 headings each followed by checkboxes, to avoid false
 * positives on PR checklists, README excerpts, etc.
 */
export function looksLikePlan(markdown: string): boolean {
  const hasCheckboxes = /^[\s]*[-*]\s+\[[ xX]\]/m.test(markdown);
  if (!hasCheckboxes) return false;

  const headings = markdown.match(/^#{1,3}\s+(.+)/gm);
  if (!headings || headings.length === 0) return false;

  // If any heading contains plan-like keywords, one heading is enough
  const planKeywords = /\b(phase|step|task|stage)\b/i;
  if (headings.some((h) => planKeywords.test(h))) return true;

  // Otherwise require at least 2 headings with checkboxes underneath
  const lines = markdown.split("\n");
  let sectionsWithCheckboxes = 0;
  let inSection = false;
  let sectionHasCheckbox = false;

  for (const line of lines) {
    if (/^#{1,3}\s+/.test(line)) {
      if (inSection && sectionHasCheckbox) sectionsWithCheckboxes++;
      inSection = true;
      sectionHasCheckbox = false;
    } else if (inSection && /^[\s]*[-*]\s+\[[ xX]\]/.test(line)) {
      sectionHasCheckbox = true;
    }
  }
  if (inSection && sectionHasCheckbox) sectionsWithCheckboxes++;

  return sectionsWithCheckboxes >= 2;
}

// ── Combined extraction ──

/**
 * Extract plans from a session's transcript entries.
 * Tries TodoWrite structured data first, falls back to markdown text scanning.
 * Returns at most one plan per session.
 */
export function extractPlansFromTranscript(entries: ReadonlyArray<TranscriptEntry>, sessionId: string): Plan | null {
  // Strategy 1: TodoWrite structured data (preferred)
  const todos = extractTodosFromTranscript(entries);
  if (todos && todos.length > 0) {
    return todosToPlan(todos, sessionId);
  }

  // Strategy 2: Scan assistant text blocks for markdown plans
  let lastPlanMarkdown: string | null = null;

  for (const entry of entries) {
    if (entry.direction !== "inbound") continue;
    const msg = entry.message;
    if (msg.type !== "assistant" || !msg.message) continue;

    const inner = msg.message as Record<string, unknown>;
    const content = inner.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type !== "text" || typeof b.text !== "string") continue;

      if (looksLikePlan(b.text)) {
        lastPlanMarkdown = b.text;
      }
    }
  }

  if (lastPlanMarkdown) {
    return parseClaudePlanMarkdown(lastPlanMarkdown, `claude-${sessionId}`, sessionId);
  }

  return null;
}
