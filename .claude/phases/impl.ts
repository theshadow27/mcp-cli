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
 * Model resolution order (first match wins, see resolveImplModel):
 *   1. `input.model` — explicit override from the orchestrator
 *   2. `ctx.state.get("model")` — pre-populated by a prior call or mcx track
 *   3. Sprint plan table — the Model column for this issue, any Claude model
 *      shortname or full ID, e.g. a `claude-fable-5` canary (fixes #1437, #2665)
 *   4. label-based heuristic fallback
 *
 * When the sprint plan overrides the heuristic default, a `model override`
 * line is logged so a per-item canary assignment is never silently dropped.
 *
 * State writes (this handler): model, provider, labels, session_id sentinel.
 * Orchestrator responsibility: replace session_id "pending:*" with the real
 * session ID after spawn; write worktree_path once the worktree is known;
 * delete session_id on spawn failure so next entry re-spawns cleanly.
 */
import { NO_REPO_ROOT, findModelInSprintPlan } from "@mcp-cli/core";
import { defineAlias, z } from "mcp-cli";
import { type Provider, buildImplCommand, buildImplPrompt, resolveImplModel } from "./impl-fn";

const ProviderSchema = z
  .string()
  .refine(
    (v): v is Provider => v === "claude" || v === "copilot" || v === "gemini" || v === "grok" || v.startsWith("acp:"),
    {
      message: 'provider must be "claude", "copilot", "gemini", "grok", or "acp:<agent>"',
    },
  );

defineAlias({
  name: "phase-impl",
  description: "Sprint phase: spawn implementation session for a tracked issue.",
  input: z.object({
    provider: ProviderSchema.default("claude"),
    labels: z.array(z.string()).default([]),
    model: z.string().optional(),
  }),
  output: z.object({
    action: z.enum(["spawn", "in-flight"]),
    command: z.array(z.string()),
    allowTools: z.array(z.string()),
    prompt: z.string(),
    model: z.string(),
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
        model: (await ctx.state.get<string>("model")) ?? "opus",
        provider: ((await ctx.state.get<string>("provider")) as Provider) ?? input.provider,
        sessionId: existing,
        worktreePath: (await ctx.state.get<string>("worktree_path")) ?? undefined,
      };
    }

    const stateModel = await ctx.state.get<string>("model");
    const planModel =
      ctx.repoRoot !== NO_REPO_ROOT ? findModelInSprintPlan(work.issueNumber, ctx.repoRoot) : null;
    const { model, override } = resolveImplModel({
      inputModel: input.model,
      stateModel,
      planModel,
      labels: input.labels,
    });
    if (override) {
      console.error(
        `work item #${work.issueNumber} model override: ${override.planModel} (default: ${override.heuristic})`,
      );
    }

    const provider = input.provider;
    const supportsWorktree = provider === "claude";
    const allowTools = ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "ExitPlanMode", "EnterPlanMode"];
    const prompt = buildImplPrompt(work.issueNumber, work.prNumber ?? null);
    const command = buildImplCommand({ provider, model, supportsWorktree, prompt, allowTools });

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
