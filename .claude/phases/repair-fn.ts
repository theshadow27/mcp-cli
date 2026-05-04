/** Core repair-phase logic, extracted for testability via dependency injection. */

export const REPAIR_ROUND_CAP = 3;

export interface RepairWork {
  id: string;
  prNumber: number;
}

export interface RepairState {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RepairDeps {
  prEdit(prNumber: number, flags: string[]): Promise<void>;
}

export type RepairResult =
  | { action: "in-flight"; reason: string; round: number; model: "opus"; prompt?: string }
  | { action: "goto"; target: "needs-attention"; reason: string; round: number }
  | {
      action: "spawn";
      reason: string;
      round: number;
      model: "opus";
      command: string[];
      prompt: string;
      allowTools: string[];
    };

export function buildRepairPrompt(prNumber: number, previousPhase: "review" | "qa"): string {
  return previousPhase === "qa"
    ? `Repair PR #${prNumber}. Read the qa:fail comment: gh pr view ${prNumber} --comments. Address every blocker. Push to existing branch.`
    : `Repair PR #${prNumber}. Read the adversarial review sticky comment: gh pr view ${prNumber} --comments. Fix all 🔴 and 🟡. Push to existing branch.`;
}

export async function runRepair(
  input: { provider: string },
  work: RepairWork,
  state: RepairState,
  deps: RepairDeps,
): Promise<RepairResult> {
  const existingSession = await state.get<string>("repair_session_id");
  if (existingSession) {
    const round = (await state.get<number>("repair_round")) ?? 1;
    const storedPrompt = await state.get<string>("repair_prompt");
    return {
      action: "in-flight",
      reason: `repair session in flight (round ${round})`,
      round,
      model: "opus",
      ...(storedPrompt ? { prompt: storedPrompt } : {}),
    };
  }

  const prevRound = (await state.get<number>("repair_round")) ?? 0;
  const round = prevRound + 1;
  if (round > REPAIR_ROUND_CAP) {
    return {
      action: "goto",
      target: "needs-attention",
      reason: `repair cap (${REPAIR_ROUND_CAP}) exceeded — escalating`,
      round: prevRound,
    };
  }

  const previous = ((await state.get<string>("previous_phase")) ?? "review") as "review" | "qa";
  const worktreePath = await state.get<string>("worktree_path");
  const prompt = buildRepairPrompt(work.prNumber, previous);
  const allowTools = ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "ExitPlanMode", "EnterPlanMode"];
  const cmdBase = input.provider.startsWith("acp:")
    ? ["mcx", "acp", "spawn", "--agent", input.provider.slice(4)]
    : ["mcx", input.provider, "spawn"];
  const worktreeFlags = worktreePath ? ["--cwd", worktreePath] : ["--worktree"];
  const command = [...cmdBase, ...worktreeFlags, "--model", "opus", "-t", prompt, "--allow", ...allowTools];

  await state.delete("qa_session_id");
  try {
    await deps.prEdit(work.prNumber, ["--remove-label", "qa:fail"]);
  } catch {
    /* best-effort */
  }

  await state.set("repair_round", round);
  await state.set("repair_prompt", prompt);
  await state.set("repair_session_id", `pending:${Date.now()}`);

  return {
    action: "spawn",
    reason: `repair round ${round}, triggered by ${previous}`,
    round,
    model: "opus",
    command,
    prompt,
    allowTools,
  };
}
