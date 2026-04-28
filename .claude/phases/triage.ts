/**
 * Phase: triage — decides scrutiny level and next phase (review or qa).
 *
 * When the PR exists: runs the estimate, applies flaky-label override,
 * returns { action: "goto", target: "review" | "qa" }.
 *
 * When no PR found: waits for pr.opened or session.result via
 * ctx.waitForEvent (#1832). On timeout: returns { action: "wait" }.
 *
 * State writes: triage_scrutiny, triage_reasons.
 */
import { defineAlias, z } from "mcp-cli";
import { runTriage } from "./triage-fn";

defineAlias({
  name: "phase-triage",
  description: "Sprint phase: post-implementation triage, decide scrutiny.",
  input: z.object({
    labels: z.array(z.string()).default([]),
    since: z.number().optional(),
  }),
  output: z.object({
    action: z.enum(["goto", "wait"]),
    target: z.enum(["review", "qa"]).optional(),
    reason: z.string(),
    scrutiny: z.enum(["low", "high"]).optional(),
    prNumber: z.number().optional(),
    metrics: z.record(z.string(), z.unknown()).optional(),
  }),
  fn: async (input, ctx) => {
    const work = ctx.workItem;
    if (!work) {
      throw new Error("phase-triage requires a work item (got: null)");
    }

    return runTriage(input, work, {
      findPr(branch: string): number | null {
        const proc = Bun.spawnSync({
          cmd: [
            "gh",
            "pr",
            "list",
            "--head",
            branch,
            "--json",
            "number",
            "-q",
            ".[0].number",
          ],
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = new TextDecoder().decode(proc.stdout).trim();
        const n = Number.parseInt(out, 10);
        return Number.isFinite(n) ? n : null;
      },
      runEstimate(prNumber: number) {
        const proc = Bun.spawnSync({
          cmd: [
            "bun",
            ".claude/skills/estimate/triage.ts",
            "--pr",
            String(prNumber),
            "--json",
          ],
          stdout: "pipe",
          stderr: "pipe",
        });
        if (proc.exitCode !== 0) {
          const err = new TextDecoder().decode(proc.stderr);
          throw new Error(`triage.ts failed: ${err}`);
        }
        return JSON.parse(new TextDecoder().decode(proc.stdout)) as {
          scrutiny: "low" | "high";
          reasons: string[];
          metrics?: Record<string, unknown>;
        };
      },
      waitForEvent(filter, opts) {
        return ctx.waitForEvent(filter, opts);
      },
      stateGet: (key) => ctx.state.get(key),
      stateSet: (key, value) => ctx.state.set(key, value),
      async updateWorkItem(id, prNumber) {
        await ctx.mcp._work_items.work_items_update({ id, prNumber });
      },
    });
  },
});
