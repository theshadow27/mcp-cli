/**
 * Phase: triage — pure compute, no session spawn.
 *
 * Runs .claude/skills/estimate/triage.ts against the PR, decides scrutiny,
 * updates the work item, and returns the next phase (review for high
 * scrutiny, qa for low). Flaky-labeled issues are forced to high scrutiny
 * per run.md.
 *
 * State writes: triage_scrutiny, triage_reasons.
 */
import { defineAlias, z } from "mcp-cli";

const DecisionSchema = z.enum(["review", "qa"]);

defineAlias({
  name: "phase-triage",
  description: "Sprint phase: post-implementation triage, decide scrutiny.",
  input: z.object({
    labels: z.array(z.string()).default([]),
  }),
  output: z.object({
    scrutiny: z.enum(["low", "high"]),
    decision: DecisionSchema,
    reasons: z.array(z.string()),
    prNumber: z.number(),
    metrics: z.record(z.string(), z.unknown()).optional(),
  }),
  fn: async (input, ctx) => {
    const work = ctx.workItem;
    if (!work) {
      throw new Error("phase-triage requires a work item (got: null)");
    }
    const missing: string[] = [];
    if (work.issueNumber == null) missing.push("issueNumber");
    if (work.branch == null) missing.push("branch");
    if (missing.length > 0) {
      throw new Error(
        `phase-triage requires ${missing.map((f) => `'${f}'`).join(" and ")} on the work item ${work.id} (missing: ${missing.join(", ")})`,
      );
    }

    // Resolve PR number via gh. Work item's prNumber is authoritative when set.
    let prNumber = work.prNumber;
    if (prNumber == null) {
      const proc = Bun.spawnSync({
        cmd: ["gh", "pr", "list", "--head", work.branch, "--json", "number", "-q", ".[0].number"],
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = new TextDecoder().decode(proc.stdout).trim();
      const n = Number.parseInt(out, 10);
      if (!Number.isFinite(n)) throw new Error(`no PR found for branch ${work.branch}`);
      prNumber = n;
    }

    // Run triage.ts --pr N --json.
    const triageProc = Bun.spawnSync({
      cmd: ["bun", ".claude/skills/estimate/triage.ts", "--pr", String(prNumber), "--json"],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (triageProc.exitCode !== 0) {
      const err = new TextDecoder().decode(triageProc.stderr);
      throw new Error(`triage.ts failed: ${err}`);
    }
    const raw = JSON.parse(new TextDecoder().decode(triageProc.stdout)) as {
      scrutiny: "low" | "high";
      reasons: string[];
      metrics?: Record<string, unknown>;
    };

    // Flaky issues are always high scrutiny — adversarial review required.
    // Labels come from input when the orchestrator passes them explicitly;
    // otherwise fall back to the comma-separated string impl.ts wrote to state.
    const labels = input.labels.length > 0
      ? input.labels
      : ((await ctx.state.get<string>("labels")) ?? "")
          .split(",")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
    const isFlaky = labels.includes("flaky");
    const scrutiny = isFlaky ? "high" : raw.scrutiny;
    const reasons = isFlaky && raw.scrutiny !== "high" ? [...raw.reasons, "label:flaky forces high scrutiny"] : raw.reasons;
    const decision: z.infer<typeof DecisionSchema> = scrutiny === "high" ? "review" : "qa";

    await ctx.state.set("triage_scrutiny", scrutiny);
    await ctx.state.set("triage_reasons", reasons.join("; "));

    // Persist PR number on the work item for the poller.
    try {
      await ctx.mcp._work_items.work_items_update({
        id: work.id,
        prNumber,
      });
    } catch {
      // work_items server unavailable — caller handles via CLI.
    }

    return {
      scrutiny,
      decision,
      reasons,
      prNumber,
      metrics: raw.metrics,
    };
  },
});
