/**
 * Permission router for Claude Code session `can_use_tool` requests.
 *
 * Three strategies:
 * - `auto`     — approve all requests (fully autonomous workers)
 * - `rules`    — match against allowlist/denylist patterns (fail-closed)
 * - `delegate` — forward to an external callback (human-in-the-loop)
 *
 * Rule evaluation is delegated to `@mcp-cli/permissions`.
 */

import { type PermissionDecision, type PermissionRule, evaluate } from "@mcp-cli/permissions";
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

/**
 * Safe tools allowed by default when no explicit --allow is provided.
 * Permits file read/write but blocks shell execution and network access.
 */
export const DEFAULT_SAFE_TOOLS: readonly string[] = Object.freeze(["Read", "Glob", "Grep", "Write", "Edit"]);

// ── Router ──

export class PermissionRouter {
  readonly strategy: PermissionStrategy;
  private readonly rules: readonly PermissionRule[];
  onDelegate: DelegateCallback | null = null;

  constructor(strategy: PermissionStrategy, rules?: PermissionRule[]) {
    this.strategy = strategy;
    this.rules = Object.freeze(rules ? [...rules] : []);
  }

  async evaluate(request: CanUseToolRequest): Promise<RouterDecision> {
    switch (this.strategy) {
      case "auto":
        return { allow: true, updatedInput: request.input };

      case "rules":
        return evaluate(this.rules, {
          toolName: request.tool_name,
          input: request.input,
        });

      case "delegate": {
        if (!this.onDelegate) {
          return { allow: false, message: "No delegate callback registered" };
        }
        return this.onDelegate(request);
      }
    }
  }
}
