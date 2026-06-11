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
    timeoutMs: z.number().optional(),
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
      async findPr(branch: string): Promise<number | null> {
        try {
          const result = await ctx.gh.repo().searchIssues({
            query: `head:${branch} is:pr is:open`,
          });
          return result.items.length > 0 ? result.items[0].number : null;
        } catch {
          return null;
        }
      },
      async runEstimate(prNumber: number) {
        const proc = Bun.spawn(["bun", ".claude/skills/estimate/triage.ts", "--pr", String(prNumber), "--json"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {}
        }, 30_000);
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        clearTimeout(timer);
        if (exitCode !== 0) {
          throw new Error(`triage.ts failed: ${stderr.trim()}`);
        }
        return JSON.parse(stdout.trim()) as {
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
