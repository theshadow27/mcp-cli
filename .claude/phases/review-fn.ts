/** Core review-phase logic, extracted for testability via dependency injection. */

import type { GhResult } from "./gh";

export const REVIEW_ROUND_CAP = 2;

export interface ReviewWork {
  id: string;
  prNumber: number;
  branch: string;
  issueNumber: number | null;
}

export interface ReviewState {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface ReviewDeps {
  gh(args: string[]): Promise<GhResult>;
  findModelInSprintPlan(issueNumber: number, repoRoot: string): "opus" | "sonnet" | null;
}

export type ReviewResult =
  | {
      action: "spawn";
      reason: string;
      round: number;
      command: string[];
      prompt: string;
      allowTools: string[];
      model: "opus" | "sonnet";
    }
  | { action: "wait"; reason: string; round: number; model?: "opus" | "sonnet" }
  | { action: "goto"; target: "repair" | "qa"; reason: string; round: number; model?: "opus" | "sonnet" };

// ── verdict heuristic (#2007) ──
// Layered match: explicit verdict line wins; if absent, fall back to
// "naked" 🔴/🟡 — emoji on a line that does NOT also carry a resolution
// marker (✅ / fixed / resolved / addressed / reverted / n/a). Surveyed
// across 200 merged PRs (49 with stickies, 38 approved): the prior
// `/🔴|🟡/.test()` regex flagged 38 of 38 approved PRs as blocked
// because reviewers reference past 🔴/🟡 in delta tables alongside
// ✅ Fixed in <sha>. The verdict-line check eliminates that whole
// false-positive class; the same-line-resolution fallback handles
// stickies the reviewer wrote without an explicit verdict header.
const VERDICT_APPROVED_RE = /✅\s*\*?\*?\s*(approved|approve)\b/i;
const VERDICT_CHANGES_RE = /(⚠️|🟡|🔴)\s*\*?\*?\s*changes\s*requested/i;
const RESOLVED_TOKEN_RE = /(✅|☑|\bfixed\b|\bresolved\b|\baddressed\b|\breverted\b|\bn\/a\b|\bnot applicable\b|\bwon[''']t fix\b)/i;

export async function scanReviewComments(
  prNumber: number,
  deps: Pick<ReviewDeps, "gh">,
): Promise<{ found: boolean; hasBlockers: boolean; summary: string }> {
  const result = await deps.gh(["pr", "view", String(prNumber), "--json", "comments", "-q", ".comments[].body"]);
  if (result.exitCode !== 0) return { found: false, hasBlockers: false, summary: "gh pr view failed" };
  const lastIdx = result.stdout.lastIndexOf("## Adversarial Review");
  if (lastIdx === -1) return { found: false, hasBlockers: false, summary: "no sticky comment yet" };
  const sticky = result.stdout.slice(lastIdx);
  const lines = sticky.split("\n");
  for (const line of lines) {
    if (VERDICT_APPROVED_RE.test(line)) {
      return { found: true, hasBlockers: false, summary: "verdict: approved" };
    }
    if (VERDICT_CHANGES_RE.test(line)) {
      return { found: true, hasBlockers: true, summary: "verdict: changes requested" };
    }
  }
  // No explicit verdict line — fall back to naked-emoji scan.
  let nakedRed = 0;
  let nakedYellow = 0;
  for (const line of lines) {
    if (!/🔴|🟡/.test(line)) continue;
    if (RESOLVED_TOKEN_RE.test(line)) continue; // same-line resolution marker
    nakedRed += (line.match(/🔴/g) ?? []).length;
    nakedYellow += (line.match(/🟡/g) ?? []).length;
  }
  if (nakedRed + nakedYellow > 0) {
    return { found: true, hasBlockers: true, summary: `blockers remain (🔴×${nakedRed}, 🟡×${nakedYellow}, no verdict line)` };
  }
  return { found: true, hasBlockers: false, summary: "all clear" };
}

export async function runReview(
  input: { provider: string; model?: "opus" | "sonnet" },
  work: ReviewWork,
  state: ReviewState,
  deps: ReviewDeps,
  repoRoot: string,
): Promise<ReviewResult> {
  const round = (await state.get<number>("review_round")) ?? 1;
  const sessionId = await state.get<string>("review_session_id");

  if (!sessionId) {
    let model: "opus" | "sonnet";
    if (input.model) {
      model = input.model;
    } else {
      const planModel =
        work.issueNumber != null && repoRoot !== "__none__"
          ? deps.findModelInSprintPlan(work.issueNumber, repoRoot)
          : null;
      model = planModel ?? "sonnet";
    }

    const allowTools = ["Read", "Glob", "Grep", "Write", "Edit", "Bash"];
    const prompt = `/adversarial-review (PR ${work.prNumber}, branch ${work.branch}, round ${round})`;
    const cmdBase = input.provider.startsWith("acp:")
      ? ["mcx", "acp", "spawn", "--agent", input.provider.slice(4)]
      : ["mcx", input.provider, "spawn"];
    const command = [...cmdBase, "--worktree", "--model", model, "-t", prompt, "--allow", ...allowTools];

    await state.set("review_round", round);
    await state.set("review_model", model);
    await state.set("review_session_id", `pending:${Date.now()}`);
    return {
      action: "spawn",
      reason: `review round ${round} starting`,
      round,
      command,
      prompt,
      allowTools,
      model,
    };
  }

  const storedModel = (await state.get<string>("review_model")) as "opus" | "sonnet" | null;
  const scan = await scanReviewComments(work.prNumber, deps);
  if (!scan.found) {
    return { action: "wait", reason: scan.summary, round, ...(storedModel ? { model: storedModel } : {}) };
  }

  if (!scan.hasBlockers) {
    return { action: "goto", target: "qa", reason: "review clean → qa", round, ...(storedModel ? { model: storedModel } : {}) };
  }

  if (round >= REVIEW_ROUND_CAP) {
    return {
      action: "goto",
      target: "qa",
      reason: `review round cap (${REVIEW_ROUND_CAP}) reached; deferring remaining items to qa`,
      round,
      ...(storedModel ? { model: storedModel } : {}),
    };
  }

  await state.set("review_round", round + 1);
  await state.set("previous_phase", "review");
  return { action: "goto", target: "repair", reason: "blockers remain → repair", round, ...(storedModel ? { model: storedModel } : {}) };
}
