/**
 * Phase: impl — spawn an implementation session for a tracked work item.
 *
 * onEnter semantics (see docs/phases.md): compute the model, build the
 * spawn command for the issue's provider, and either execute it (when the
 * runtime supports in-handler spawning, tracked in #1286) or emit the
 * resolved plan as JSON so the orchestrator can run it.
 *
 * The handler is idempotent on re-entry: if `session_id` is already set in
 * state, it returns the existing session plus `action: "in-flight"`.
 *
 * Model resolution order (first match wins):
 *   1. `input.model` — explicit override from the orchestrator
 *   2. `ctx.state.get("model")` — pre-populated by a prior call or mcx track
 *   3. Sprint plan table — reads the latest `.claude/sprints/sprint-*.md` and
 *      locates the Model column for this issue number (fixes #1437)
 *   4. `pickModel(labels)` — label-based heuristic fallback
 *
 * State writes (this handler): model, provider, labels, session_id sentinel.
 * Orchestrator responsibility: replace session_id "pending:*" with the real
 * session ID after spawn; write worktree_path once the worktree is known;
 * delete session_id on spawn failure so next entry re-spawns cleanly.
 */
import { findModelInSprintPlan } from "@mcp-cli/core";
import { defineAlias, z } from "mcp-cli";

type Provider = "claude" | "copilot" | "gemini" | `acp:${string}`;

const ProviderSchema = z
  .string()
  .refine((v): v is Provider => v === "claude" || v === "copilot" || v === "gemini" || v.startsWith("acp:"), {
    message: 'provider must be "claude", "copilot", "gemini", or "acp:<agent>"',
  });

function commandForProvider(provider: Provider): string[] {
  if (provider.startsWith("acp:")) {
    const agent = provider.slice("acp:".length);
    return ["mcx", "acp", "spawn", "--agent", agent];
  }
  return ["mcx", provider, "spawn"];
}

function pickModel(labels: string[]): "opus" | "sonnet" {
  // Flaky work always needs deep analysis (see run.md history).
  if (labels.includes("flaky")) return "opus";
  // Docs-only is cheap; everything else defaults to opus.
  if (labels.includes("docs-only") || labels.includes("documentation")) return "sonnet";
  return "opus";
}

defineAlias({
  name: "phase-impl",
  description: "Sprint phase: spawn implementation session for a tracked issue.",
  input: z.object({
    provider: ProviderSchema.default("claude"),
    labels: z.array(z.string()).default([]),
    model: z.enum(["opus", "sonnet"]).optional(),
  }),
  output: z.object({
    action: z.enum(["spawn", "in-flight"]),
    command: z.array(z.string()),
    allowTools: z.array(z.string()),
    prompt: z.string(),
    model: z.enum(["opus", "sonnet"]),
    provider: ProviderSchema,
    sessionId: z.string().optional(),
    worktreePath: z.string().optional(),
  }),
  fn: async (input, ctx) => {
    const work = ctx.workItem;
    if (!work || work.issueNumber == null) {
      throw new Error("phase-impl requires a tracked work item with an issueNumber");
    }

    const existing = await ctx.state.get<string>("session_id");
    if (existing) {
      return {
        action: "in-flight" as const,
        command: [],
        allowTools: [],
        prompt: "",
        model: ((await ctx.state.get<string>("model")) as "opus" | "sonnet") ?? "opus",
        provider: ((await ctx.state.get<string>("provider")) as Provider) ?? input.provider,
        sessionId: existing,
        worktreePath: (await ctx.state.get<string>("worktree_path")) ?? undefined,
      };
    }

    // Resolve model: explicit input → pre-set state → sprint plan → label heuristic
    let model: "opus" | "sonnet";
    if (input.model) {
      model = input.model;
    } else {
      const stateModel = await ctx.state.get<string>("model");
      if (stateModel === "opus" || stateModel === "sonnet") {
        model = stateModel;
      } else {
        const planModel = findModelInSprintPlan(work.issueNumber, process.cwd());
        model = planModel ?? pickModel(input.labels);
      }
    }

    const provider = input.provider;
    const allowTools = ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "ExitPlanMode", "EnterPlanMode"];
    const prompt = `/implement ${work.issueNumber}`;
    const command = [
      ...commandForProvider(provider),
      "--worktree",
      "--model",
      model,
      "-t",
      prompt,
      "--allow",
      ...allowTools,
    ];

    await ctx.state.set("provider", provider);
    await ctx.state.set("model", model);
    await ctx.state.set("labels", input.labels.join(","));
    // Write a pending sentinel so re-entry returns "in-flight" instead of
    // re-spawning. Orchestrator replaces this with the real session ID after
    // spawn; deletes it on spawn failure.
    await ctx.state.set("session_id", `pending:${Date.now()}`);

    return {
      action: "spawn" as const,
      command,
      allowTools,
      prompt,
      model,
      provider,
    };
  },
});
