/**
 * Core triage logic, extracted for testability.
 *
 * The defineAlias wrapper in triage.ts constructs TriageDeps from the
 * AliasContext and delegates here.
 */

export interface TriageEventFilter {
  type?: string | string[];
  workItem?: string;
}

export interface TriageEvent {
  event: string;
  prNumber?: number;
  [key: string]: unknown;
}

export interface TriageWork {
  id: string;
  issueNumber: number | null;
  prNumber: number | null;
  branch: string | null;
}

export interface TriageDeps {
  findPr(branch: string): number | null;
  runEstimate(prNumber: number): {
    scrutiny: "low" | "high";
    reasons: string[];
    metrics?: Record<string, unknown>;
  };
  waitForEvent(
    filter: TriageEventFilter,
    opts?: { timeoutMs?: number; since?: number },
  ): Promise<TriageEvent>;
  stateGet<T>(key: string): Promise<T | undefined>;
  stateSet(key: string, value: unknown): Promise<void>;
  updateWorkItem(id: string, prNumber: number): Promise<void>;
}

export type TriageResult =
  | {
      action: "goto";
      target: "review" | "qa";
      reason: string;
      scrutiny: "low" | "high";
      prNumber: number;
      metrics?: Record<string, unknown>;
    }
  | { action: "wait"; reason: string };

const WAIT_TIMEOUT_MS = 30_000;

export async function runTriage(
  input: { labels: string[]; since?: number },
  work: TriageWork,
  deps: TriageDeps,
): Promise<TriageResult> {
  const missing: string[] = [];
  if (work.issueNumber == null) missing.push("issueNumber");
  if (work.branch == null) missing.push("branch");
  if (missing.length > 0) {
    throw new Error(
      `phase-triage requires ${missing.map((f) => `'${f}'`).join(" and ")} on the work item ${work.id} (missing: ${missing.join(", ")})`,
    );
  }

  let prNumber = work.prNumber;
  if (prNumber == null) {
    prNumber = deps.findPr(work.branch!);
  }

  if (prNumber == null) {
    try {
      const event = await deps.waitForEvent(
        { type: ["pr.opened", "session.result"], workItem: work.id },
        { timeoutMs: WAIT_TIMEOUT_MS, since: input.since },
      );
      if (event.prNumber != null) {
        prNumber = event.prNumber;
      } else {
        prNumber = deps.findPr(work.branch!);
      }
      if (prNumber == null) {
        return {
          action: "wait",
          reason: `event ${event.event} received but no PR found for ${work.branch}`,
        };
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "WaitTimeoutError") {
        return {
          action: "wait",
          reason: `no PR found for branch ${work.branch}, waiting for pr.opened or session.result`,
        };
      }
      throw err;
    }
  }

  const raw = deps.runEstimate(prNumber);

  const labels =
    input.labels.length > 0
      ? input.labels
      : ((await deps.stateGet<string>("labels")) ?? "")
          .split(",")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
  const isFlaky = labels.includes("flaky");
  const scrutiny = isFlaky ? "high" : raw.scrutiny;
  const reasons =
    isFlaky && raw.scrutiny !== "high"
      ? [...raw.reasons, "label:flaky forces high scrutiny"]
      : raw.reasons;
  const decision = scrutiny === "high" ? "review" : "qa";

  await deps.stateSet("triage_scrutiny", scrutiny);
  await deps.stateSet("triage_reasons", reasons.join("; "));

  try {
    await deps.updateWorkItem(work.id, prNumber);
  } catch {
    // work_items server unavailable — caller handles via CLI
  }

  return {
    action: "goto",
    target: decision,
    reason: reasons.join("; "),
    scrutiny,
    prNumber,
    metrics: raw.metrics,
  };
}
