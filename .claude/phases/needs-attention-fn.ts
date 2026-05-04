/** Core needs-attention-phase logic, extracted for testability via dependency injection. */

export interface NeedsAttentionWork {
  id: string;
  prNumber: number;
  issueNumber: number;
}

export interface NeedsAttentionState {
  get<T>(key: string): Promise<T | undefined>;
}

export interface NeedsAttentionDeps {
  prEdit(prNumber: number, flags: string[]): Promise<void>;
  prComment(prNumber: number, body: string): Promise<void>;
  updateWorkItemPhase(id: string, phase: string): Promise<void>;
}

export interface NeedsAttentionResult {
  prNumber: number;
  issueNumber: number;
  reviewRound: number;
  repairRound: number;
  qaFailRound: number;
  commented: boolean;
}

export function buildNeedsAttentionBody(
  prNumber: number,
  reviewRound: number,
  repairRound: number,
  qaFailRound: number,
  triage: string,
): string {
  return [
    "## 🚩 Needs attention",
    "",
    `Automated sprint pipeline exhausted its round caps on PR #${prNumber}.`,
    "",
    "| Round type | Count |",
    "|------------|-------|",
    `| Review     | ${reviewRound} |`,
    `| Repair     | ${repairRound} |`,
    `| QA fail    | ${qaFailRound} |`,
    "",
    `Triage scrutiny was **${triage}**. An operator should decide between: refining the issue spec, taking over the PR manually, or closing it.`,
  ].join("\n");
}

export async function runNeedsAttention(
  work: NeedsAttentionWork,
  state: NeedsAttentionState,
  deps: NeedsAttentionDeps,
): Promise<NeedsAttentionResult> {
  const reviewRound = (await state.get<number>("review_round")) ?? 0;
  const repairRound = (await state.get<number>("repair_round")) ?? 0;
  const qaFailRound = (await state.get<number>("qa_fail_round")) ?? 0;
  const triage = (await state.get<string>("triage_scrutiny")) ?? "unknown";

  await Promise.all(
    ["qa:pass", "qa:fail"].map((label) => deps.prEdit(work.prNumber, ["--remove-label", label]).catch(() => {})),
  );

  const body = buildNeedsAttentionBody(work.prNumber, reviewRound, repairRound, qaFailRound, triage);

  let commented = false;
  try {
    await deps.prComment(work.prNumber, body);
    commented = true;
  } catch {
    /* best-effort */
  }

  try {
    await deps.updateWorkItemPhase(work.id, "needs-attention");
  } catch {
    /* non-fatal */
  }

  return {
    prNumber: work.prNumber,
    issueNumber: work.issueNumber,
    reviewRound,
    repairRound,
    qaFailRound,
    commented,
  };
}
