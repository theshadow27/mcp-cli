/** Core qa-phase logic, extracted for testability via dependency injection. */

import { type GhLabelEvent, type GhOp, type GhResult, type VerdictContext, validateVerdictLabel } from "./phase-types";
export type { GhOp, GhResult };

export const QA_FAIL_CAP = 2;

export interface QaWork {
  id: string;
  prNumber: number;
  branch: string;
  issueNumber: number;
}

export interface QaState {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface QaDeps {
  gh(op: GhOp): Promise<GhResult>;
  prEdit(prNumber: number, flags: string[]): Promise<void>;
}

export type QaResult =
  | {
      action: "spawn";
      reason: string;
      model: "sonnet";
      command: string[];
      prompt: string;
      allowTools: string[];
    }
  | { action: "wait"; reason: string; model: "sonnet"; prompt: string }
  | {
      action: "goto";
      target: "done" | "repair" | "needs-attention";
      reason: string;
      model: "sonnet";
      prompt: string;
      round?: number;
    };

// ── verdict validation (#2652) ──
// Same hardened validation as review-fn: labels are validated against the
// GitHub issue-events timeline. See readReviewLabels and #2652.
export async function readQaLabels(
  prNumber: number,
  deps: Pick<QaDeps, "gh">,
  roundStartedAt: number,
): Promise<{ hasPass: boolean; hasFail: boolean; rejections: string[] }> {
  const result = await deps.gh({ op: "pr:labels", prNumber });
  if (result.exitCode !== 0) return { hasPass: false, hasFail: false, rejections: [] };
  const names = new Set(result.stdout.split(/\r?\n/).map((l) => l.trim()));

  let hasPass = names.has("qa:pass");
  let hasFail = names.has("qa:fail");
  if (!hasPass && !hasFail) return { hasPass: false, hasFail: false, rejections: [] };

  const [eventsResult, authorResult, headDateResult] = await Promise.all([
    deps.gh({ op: "pr:label-events", prNumber }),
    deps.gh({ op: "pr:author", prNumber }),
    deps.gh({ op: "pr:head-date", prNumber }),
  ]);

  if (eventsResult.exitCode !== 0) {
    return {
      hasPass: false,
      hasFail: false,
      rejections: [`label-events fetch failed (${eventsResult.stderr}) — fail closed`],
    };
  }
  if (authorResult.exitCode !== 0 || headDateResult.exitCode !== 0) {
    return { hasPass: false, hasFail: false, rejections: [`verdict context fetch failed — fail closed`] };
  }

  let events: GhLabelEvent[];
  try {
    events = JSON.parse(eventsResult.stdout);
  } catch {
    return { hasPass: false, hasFail: false, rejections: [`label-events JSON unparseable — fail closed`] };
  }
  if (!Array.isArray(events)) {
    return { hasPass: false, hasFail: false, rejections: [`label-events not an array — fail closed`] };
  }

  const vctx: VerdictContext = {
    prAuthor: authorResult.stdout.trim(),
    roundStartedAt,
    headCommitDate: headDateResult.stdout.trim(),
  };
  const rejections: string[] = [];

  if (hasPass) {
    const v = validateVerdictLabel("qa:pass", events, vctx);
    if (!v.valid) {
      hasPass = false;
      rejections.push(v.rejection);
    }
  }
  if (hasFail) {
    const v = validateVerdictLabel("qa:fail", events, vctx);
    if (!v.valid) {
      hasFail = false;
      rejections.push(v.rejection);
    }
  }

  return { hasPass, hasFail, rejections };
}

async function removeLabel(prNumber: number, label: string, deps: Pick<QaDeps, "prEdit">): Promise<void> {
  try {
    await deps.prEdit(prNumber, ["--remove-label", label]);
  } catch {
    /* best-effort */
  }
}

export async function runQa(
  input: { provider: string },
  work: QaWork,
  state: QaState,
  deps: QaDeps,
): Promise<QaResult> {
  const sessionId = await state.get<string>("qa_session_id");
  const qaModel = "sonnet" as const;
  const qaPrompt = `/qa ${work.issueNumber} (PR ${work.prNumber}, branch ${work.branch})`;

  if (!sessionId) {
    const worktreePath = await state.get<string>("worktree_path");
    const allowTools = ["Read", "Glob", "Grep", "Write", "Edit", "Bash"];
    const cmdBase = input.provider.startsWith("acp:")
      ? ["mcx", "acp", "spawn", "--agent", input.provider.slice(4)]
      : ["mcx", input.provider, "spawn"];
    const worktreeFlags = worktreePath ? ["--cwd", worktreePath] : ["--worktree"];
    const command = [...cmdBase, ...worktreeFlags, "--model", qaModel, "-t", qaPrompt, "--allow", ...allowTools];
    const spawnedAt = Date.now();
    await state.set("qa_session_id", `pending:${spawnedAt}`);
    await state.set("qa_spawned_at", spawnedAt);
    return {
      action: "spawn",
      reason: "qa session starting",
      model: qaModel,
      command,
      prompt: qaPrompt,
      allowTools,
    };
  }

  const roundStartedAt = (await state.get<number>("qa_spawned_at")) ?? 0;
  if (typeof roundStartedAt !== "number" || roundStartedAt === 0 || Number.isNaN(roundStartedAt)) {
    return {
      action: "wait",
      reason: "qa_spawned_at missing or invalid in state — fail closed; re-spawn to populate",
      model: qaModel,
      prompt: qaPrompt,
    };
  }
  const { hasPass, hasFail, rejections } = await readQaLabels(work.prNumber, deps, roundStartedAt);
  if (!hasPass && !hasFail) {
    const suffix = rejections.length > 0 ? ` (rejected: ${rejections.join("; ")})` : "";
    return { action: "wait", reason: `qa:pass / qa:fail label not set yet${suffix}`, model: qaModel, prompt: qaPrompt };
  }

  if (hasPass) {
    if (hasFail) await removeLabel(work.prNumber, "qa:fail", deps);
    return { action: "goto", target: "done", reason: "qa:pass → done", model: qaModel, prompt: qaPrompt };
  }

  const round = ((await state.get<number>("qa_fail_round")) ?? 0) + 1;
  if (round > QA_FAIL_CAP) {
    return {
      action: "goto",
      target: "needs-attention",
      reason: `qa fail cap (${QA_FAIL_CAP}) exceeded — escalating`,
      round: round - 1,
      model: qaModel,
      prompt: qaPrompt,
    };
  }
  await state.set("qa_fail_round", round);
  await state.set("previous_phase", "qa");
  return {
    action: "goto",
    target: "repair",
    reason: `qa:fail round ${round} → repair`,
    round,
    model: qaModel,
    prompt: qaPrompt,
  };
}
