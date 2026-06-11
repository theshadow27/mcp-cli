/**
 * Utilities for reading the sprint plan markdown file.
 *
 * Sprint plans live at `.claude/sprints/sprint-<N>.md` and contain a markdown
 * table with a `#` column (issue number) and a `Model` column. The impl phase
 * uses these to pick the right model per issue (#1437). The Model column may
 * name any Claude model — a shortname (`opus`, `sonnet`, `fable`, `haiku`) or a
 * full ID (`claude-fable-5`) — not just opus/sonnet, so per-item canary
 * assignments (e.g. a fable A/B run) survive the phase-run path (#2665).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MODEL_SHORTNAMES } from "./model";

/**
 * A Model-column cell counts as a model when it is a known shortname or a full
 * Claude model ID. Unrecognized values (typos, non-Claude names like "gpt4")
 * are ignored so the impl phase falls back to its label heuristic rather than
 * forwarding a bad `--model` value.
 */
function isRecognizedModel(value: string): boolean {
  if (value in MODEL_SHORTNAMES) return true;
  return /^claude-[a-z0-9.-]+$/.test(value);
}

/**
 * Parse the Model column from a sprint plan markdown table for the given issue.
 *
 * Handles issue numbers formatted as plain "1437" or bold "**1437**".
 * Multiple tables per file are supported — each non-table line between
 * table blocks resets column state so the next table header is picked up.
 *
 * Returns the recognized model name verbatim (shortname or full ID), or null.
 */
export function parseModelFromSprintTable(text: string, issueNumber: number): string | null {
  let modelColIdx = -1;
  let issueColIdx = -1;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      // Exiting a table block — reset so the next table header is picked up.
      if (modelColIdx >= 0) {
        modelColIdx = -1;
        issueColIdx = -1;
      }
      continue;
    }

    const cols = trimmed
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());

    // Separator row (e.g. "|---|-------|")
    if (cols.every((c) => /^[-: ]+$/.test(c))) continue;

    if (modelColIdx === -1) {
      // Header row — locate the # and Model columns
      const mIdx = cols.findIndex((c) => c.toLowerCase() === "model");
      const iIdx = cols.findIndex((c) => c === "#");
      if (mIdx >= 0 && iIdx >= 0) {
        modelColIdx = mIdx;
        issueColIdx = iIdx;
      }
      continue;
    }

    // Data row — match the target issue number
    const issueCell = cols[issueColIdx] ?? "";
    const numMatch = issueCell.match(/\d+/);
    if (!numMatch || Number.parseInt(numMatch[0], 10) !== issueNumber) continue;

    const modelCell = (cols[modelColIdx] ?? "").toLowerCase().trim();
    if (modelCell && isRecognizedModel(modelCell)) return modelCell;
  }

  return null;
}

/**
 * Scan `.claude/sprints/sprint-*.md` files (latest sprint first) and return
 * the model declared for the given issue number, or null if not found.
 */
export function findModelInSprintPlan(issueNumber: number, repoRoot: string): string | null {
  const sprintDir = join(repoRoot, ".claude", "sprints");
  let files: string[];
  try {
    files = readdirSync(sprintDir).filter((f) => /^sprint-\d+\.md$/.test(f));
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  // Sort descending so the most recent sprint is checked first.
  files.sort((a, b) => {
    const numA = Number.parseInt(a.match(/(\d+)/)?.[1] ?? "0", 10);
    const numB = Number.parseInt(b.match(/(\d+)/)?.[1] ?? "0", 10);
    return numB - numA;
  });

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(sprintDir, file), "utf-8");
    } catch {
      continue;
    }
    const model = parseModelFromSprintTable(text, issueNumber);
    if (model !== null) return model;
  }

  return null;
}
