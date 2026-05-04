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

export async function scanReviewComments(
  prNumber: number,
  deps: Pick<ReviewDeps, "gh">,
): Promise<{ found: boolean; hasBlockers: boolean; summary: string }> {
  const result = await deps.gh(["pr", "view", String(prNumber), "--json", "comments", "-q", ".comments[].body"]);
  if (result.exitCode !== 0) return { found: false, hasBlockers: false, summary: "gh pr view failed" };
  const sticky = result.stdout.split(/\n{2,}/).reverse().find((b) => b.includes("## Adversarial Review"));
  if (!sticky) return { found: false, hasBlockers: false, summary: "no sticky comment yet" };
  const hasBlockers = /🔴|🟡/.test(sticky);
  return { found: true, hasBlockers, summary: hasBlockers ? "blockers remain" : "all clear" };
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
