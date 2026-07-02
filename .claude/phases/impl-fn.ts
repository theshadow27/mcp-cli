/** Core impl-phase logic, extracted for testability. */

export type Provider = "claude" | "copilot" | "gemini" | "grok" | `acp:${string}`;

// ── verify-hypothesis injection (#2804) ──
// A prescribed root cause is a hypothesis, not a spec (implement.md Step 1b).
// #2740's disproof and #2729's repro-first discipline paid off in sprint 73 but
// were never prompted. When the issue carries a prescribed root cause, require a
// "Reproduction evidence:" section at the plan checkpoint before any impl code.
const VERIFY_HYPOTHESIS_MANDATE = `

VERIFY-THE-HYPOTHESIS MANDATE (this issue prescribes a root cause / carries an investigation):
Treat the prescribed root cause as a HYPOTHESIS, not a spec (implement.md Step 1b).
Before writing any implementation code, reproduce the claimed mechanism and add a
"Reproduction evidence:" section to your plan checkpoint quoting what you observed
(commands, output, file:line). If the evidence contradicts the prescription, do NOT
cargo-cult the named file — fix the real cause and post the discrepancy as an issue
comment. A verified disproof is a valid outcome; a no-op fix on a stale diagnosis is not.`;

/**
 * Detect a prescribed-root-cause signal on the issue. Any of:
 *   - the issue carries the `flaky` or `needs-attention` label, or
 *   - an issue comment reads like an investigation / root-cause writeup
 *     ("Investigation:", "Root cause:", "Reproduction:", "Repro:").
 */
export function detectPrescribedRootCause(opts: { labels: string[]; commentBodies: string[] }): boolean {
  if (opts.labels.includes("flaky") || opts.labels.includes("needs-attention")) return true;
  const signal = /\b(investigation|root cause|reproduction|repro)\s*:/i;
  return opts.commentBodies.some((body) => signal.test(body));
}

export function buildImplPrompt(
  issueNumber: number,
  prNumber: number | null,
  opts: { verifyHypothesis?: boolean } = {},
): string {
  const resolveStep =
    prNumber != null
      ? `\nAfter replying to each addressed thread, resolve it: mcx pr comments ${prNumber} resolve --all-addressed`
      : "";
  const verifyStep = opts.verifyHypothesis ? VERIFY_HYPOTHESIS_MANDATE : "";
  return `/implement ${issueNumber}${resolveStep}${verifyStep}`;
}

export function commandForProvider(provider: Provider): string[] {
  if (provider.startsWith("acp:")) {
    const agent = provider.slice("acp:".length);
    return ["mcx", "acp", "spawn", "--agent", agent];
  }
  return ["mcx", provider, "spawn"];
}

/**
 * Label-based heuristic fallback when no model is assigned upstream.
 *
 * Flaky work always needs deep analysis (see run.md history). Orchestrator
 * gate: a flaky issue must have a nerd-snipe root-cause comment on the issue
 * before reaching this phase — see .claude/memory/feedback_flaky_tests.md and
 * run.md "Flaky / CI-instability issues — nerd-snipe gate before impl".
 * Without it, expect symptom-masking patches (sprint 47 / #1870).
 */
export function pickModelFromLabels(labels: string[]): string {
  if (labels.includes("flaky")) return "opus";
  if (labels.includes("docs-only") || labels.includes("documentation")) return "sonnet";
  return "opus";
}

export interface ModelResolution {
  model: string;
  /**
   * Set when the sprint-plan model was used and it differs from the label
   * heuristic — i.e. the plan deliberately overrode the default. Drives the
   * "model override" log line so a canary mismatch is never silent (#2665).
   */
  override: { planModel: string; heuristic: string } | null;
}

/**
 * Resolve the model for an impl spawn (first match wins):
 *   1. explicit input override
 *   2. pre-set work-item state (mcx track / prior call)
 *   3. sprint plan Model column
 *   4. label-based heuristic
 *
 * Any non-empty string is accepted at each tier so per-item assignments like a
 * `claude-fable-5` canary survive instead of being narrowed back to opus/sonnet.
 */
export function resolveImplModel(opts: {
  inputModel?: string;
  stateModel?: string | null;
  planModel?: string | null;
  labels: string[];
}): ModelResolution {
  if (opts.inputModel) return { model: opts.inputModel, override: null };
  if (opts.stateModel) return { model: opts.stateModel, override: null };

  const heuristic = pickModelFromLabels(opts.labels);
  if (opts.planModel) {
    return {
      model: opts.planModel,
      override: opts.planModel !== heuristic ? { planModel: opts.planModel, heuristic } : null,
    };
  }
  return { model: heuristic, override: null };
}

export function buildImplCommand(opts: {
  provider: Provider;
  model: string;
  supportsWorktree: boolean;
  prompt: string;
  allowTools: string[];
}): string[] {
  return [
    ...commandForProvider(opts.provider),
    ...(opts.supportsWorktree ? ["--worktree"] : []),
    "--model",
    opts.model,
    "-t",
    opts.prompt,
    "--allow",
    ...opts.allowTools,
  ];
}
