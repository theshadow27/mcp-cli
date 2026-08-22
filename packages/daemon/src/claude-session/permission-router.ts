/**
 * Permission router for Claude Code session `can_use_tool` requests.
 *
 * Three strategies:
 * - `auto`     — the child's own auto-mode classifier gates (see below)
 * - `rules`    — match against allowlist/denylist patterns (fail-closed)
 * - `delegate` — forward to an external callback (human-in-the-loop)
 *
 * Rule evaluation is delegated to `@mcp-cli/permissions`.
 *
 * ## `auto` (#3119)
 *
 * `auto` used to mean "approve everything", because when it was written Claude
 * Code had no auto-mode classifier to delegate to. It has one now, and an
 * `auto` session is spawned with `--permission-mode auto` so the classifier is
 * the gate — see `permission-mode.ts` for where that is decided.
 *
 * That leaves two distinct situations, which `childGated` distinguishes:
 *
 * - **`childGated: true`** — the child got auto mode. Verified against claude
 *   2.1.239: it does not round-trip anything the classifier approved, so a
 *   `can_use_tool` arriving here is by construction something the classifier
 *   did *not* wave through (e.g. `AskUserQuestion`, which needs a human this
 *   session hasn't got) or a child that ignored the flag. Both deny.
 * - **`childGated: false`** — auto mode could not be handed over (a worktree
 *   session, where losing the round-trip would disable ContainmentGuard, or a
 *   binary too old to accept the flag). The daemon is still the gate, so the
 *   pre-#3119 allow stands and ContainmentGuard runs in front of it. The
 *   downgrade is logged and emitted as a monitor event by the spawn path — it
 *   is never silent.
 */

import { type PermissionDecision, type PermissionRule, assertValidRules, evaluate } from "@mcp-cli/permissions";
import type { CanUseTool } from "./ndjson";

// ── Re-exports for backward compatibility ──

export type { PermissionRule, PermissionDecision } from "@mcp-cli/permissions";

export type PermissionStrategy = "auto" | "rules" | "delegate";

/** Extended decision type with delegate-specific fields. */
export type RouterDecision = PermissionDecision & {
  updatedPermissions?: Array<{ tool: string; action: "allow" | "deny" }>;
};

export type CanUseToolRequest = CanUseTool["request"];

export type DelegateCallback = (request: CanUseToolRequest) => Promise<RouterDecision>;

// ── Defaults ──

export { DEFAULT_SAFE_TOOLS } from "@mcp-cli/core";

// ── Router ──

/** Deny message for a request that reaches a router whose child is gating. */
export const CHILD_GATED_DENY_MESSAGE =
  "Denied by mcpd: this session runs under --permission-mode auto, so the Claude Code auto-mode classifier decides tool permissions and no human is attached to answer a prompt. Proceed with work that does not need this call, or report what you need and why.";

export class PermissionRouter {
  readonly strategy: PermissionStrategy;
  /** True when the child was spawned with `--permission-mode auto` (#3119). */
  readonly childGated: boolean;
  private readonly rules: readonly PermissionRule[];
  onDelegate: DelegateCallback | null = null;

  constructor(strategy: PermissionStrategy, rules?: PermissionRule[], opts?: { childGated?: boolean }) {
    this.strategy = strategy;
    this.childGated = opts?.childGated ?? false;
    if (rules) assertValidRules(rules);
    this.rules = Object.freeze(rules ? [...rules] : []);
  }

  async evaluate(request: CanUseToolRequest): Promise<RouterDecision> {
    switch (this.strategy) {
      case "auto":
        // The classifier already approved everything it was going to approve
        // without asking us, so anything still arriving here is not approved.
        if (this.childGated) return { allow: false, matched: true, message: CHILD_GATED_DENY_MESSAGE };
        return { allow: true, matched: true, updatedInput: request.input };

      case "rules":
        return evaluate(this.rules, {
          toolName: request.tool_name,
          input: request.input,
        });

      case "delegate": {
        if (!this.onDelegate) {
          return { allow: false, matched: false, message: "No delegate callback registered" };
        }
        return this.onDelegate(request);
      }
    }
  }
}
