/** Core qa-phase logic, extracted for testability via dependency injection. */

import type { GhResult } from "./gh";

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
  gh(args: string[]): Promise<GhResult>;
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
  | { action: "goto"; target: "done" | "repair" | "needs-attention"; reason: string; model: "sonnet"; prompt: string; round?: number };

export async function readQaLabels(
  prNumber: number,
  deps: Pick<QaDeps, "gh">,
): Promise<{ hasPass: boolean; hasFail: boolean }> {
  const result = await deps.gh(["pr", "view", String(prNumber), "--json", "labels", "-q", ".labels[].name"]);
  if (result.exitCode !== 0) return { hasPass: false, hasFail: false };
  const names = new Set(result.stdout.split(/\r?\n/).map((l) => l.trim()));
  return { hasPass: names.has("qa:pass"), hasFail: names.has("qa:fail") };
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
    await state.set("qa_session_id", `pending:${Date.now()}`);
    return {
      action: "spawn",
      reason: "qa session starting",
      model: qaModel,
      command,
      prompt: qaPrompt,
      allowTools,
    };
  }

  const { hasPass, hasFail } = await readQaLabels(work.prNumber, deps);
  if (!hasPass && !hasFail) {
    return { action: "wait", reason: "qa:pass / qa:fail label not set yet", model: qaModel, prompt: qaPrompt };
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
