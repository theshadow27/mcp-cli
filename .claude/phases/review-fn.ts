/** Core review-phase logic, extracted for testability via dependency injection. */

import type { GhOp, GhResult } from "./phase-types";
export type { GhOp, GhResult };

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
  gh(op: GhOp): Promise<GhResult>;
  prEdit(prNumber: number, flags: string[]): Promise<void>;
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

// ── typed verdict channel (#2575) ──
// The review verdict is read from a PR LABEL the reviewer sets transactionally
// (`review:pass` / `review:changes`), mirroring qa's `qa:pass`/`qa:fail`. We do
// NOT scrape the sticky comment body: prose is attacker-influenced free text in
// a multi-agent environment, so a quoted/forwarded `✅ APPROVED` could advance a
// PR no reviewer approved (the merge-gate prompt-injection vector). A label is a
// structured signal the agent must deliberately apply — the only control signal
// the gate trusts. The prior prose-scraping heuristic (#2007) is removed.
export async function readReviewLabels(
  prNumber: number,
  deps: Pick<ReviewDeps, "gh">,
): Promise<{ hasPass: boolean; hasChanges: boolean }> {
  const result = await deps.gh({ op: "pr:labels", prNumber });
  if (result.exitCode !== 0) return { hasPass: false, hasChanges: false };
  const names = new Set(result.stdout.split(/\r?\n/).map((l) => l.trim()));
  return { hasPass: names.has("review:pass"), hasChanges: names.has("review:changes") };
}

async function removeLabel(prNumber: number, label: string, deps: Pick<ReviewDeps, "prEdit">): Promise<void> {
  try {
    await deps.prEdit(prNumber, ["--remove-label", label]);
  } catch {
    /* best-effort */
  }
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
    const resolveStep = `After replying to each addressed thread, resolve it: mcx pr comments ${work.prNumber} resolve --all-addressed`;
    const prompt = `/adversarial-review (PR ${work.prNumber}, branch ${work.branch}, round ${round})\n${resolveStep}`;
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
  const withModel = storedModel ? { model: storedModel } : {};
  const { hasPass, hasChanges } = await readReviewLabels(work.prNumber, deps);

  // No verdict label yet — the reviewer hasn't decided. Wait (never trust prose).
  if (!hasPass && !hasChanges) {
    return { action: "wait", reason: "review:pass / review:changes label not set yet", round, ...withModel };
  }

  // Approved wins if both are somehow set; clear the stale changes label.
  if (hasPass) {
    if (hasChanges) await removeLabel(work.prNumber, "review:changes", deps);
    return { action: "goto", target: "qa", reason: "review:pass → qa", round, ...withModel };
  }

  // review:changes — blockers remain. Consume (clear) the verdict label co-located
  // with the decision to trust it: the phase that *reads* a verdict invalidates it,
  // so a re-entry after the repair round waits for the next reviewer's fresh verdict
  // instead of replaying this stale one. Without this, the round-2 reviewer is
  // spawned but its verdict is never consumed — `review_round` is already at the cap,
  // so the next tick reads the stale `review:changes` and misroutes to qa, silently
  // defeating the two-review guarantee (mirror-replay drift, #2649). qa is safe by a
  // different seam — `repair-fn` clears `qa:fail` on every repair spawn.
  await removeLabel(work.prNumber, "review:changes", deps);

  if (round >= REVIEW_ROUND_CAP) {
    return {
      action: "goto",
      target: "qa",
      reason: `review round cap (${REVIEW_ROUND_CAP}) reached; deferring remaining items to qa`,
      round,
      ...withModel,
    };
  }

  await state.set("review_round", round + 1);
  await state.set("previous_phase", "review");
  return { action: "goto", target: "repair", reason: "review:changes → repair", round, ...withModel };
}
