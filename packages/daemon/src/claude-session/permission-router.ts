/**
 * Permission router for Claude Code session `can_use_tool` requests.
 *
 * Three strategies:
 * - `auto`     — approve all requests (fully autonomous workers)
 * - `rules`    — match against allowlist/denylist patterns (fail-closed)
 * - `delegate` — forward to an external callback (human-in-the-loop)
 */

import type { CanUseTool } from "./ndjson";

// ── Types ──

export type PermissionRule = {
  /** Glob-style pattern: "Read", "Bash", "Bash(git *)" */
  tool: string;
  action: "allow" | "deny";
};

export type PermissionStrategy = "auto" | "rules" | "delegate";

export type PermissionDecision = {
  allow: boolean;
  message?: string;
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: Array<{ tool: string; action: "allow" | "deny" }>;
};

export type CanUseToolRequest = CanUseTool["request"];

export type DelegateCallback = (request: CanUseToolRequest) => Promise<PermissionDecision>;

// ── Rule matching ──

/**
 * Parse a rule pattern like "Bash(git *)" into { tool, argPrefix }.
 * Plain patterns like "Read" have no argPrefix.
 */
function parsePattern(pattern: string): { tool: string; argPrefix: string | null } {
  const match = pattern.match(/^(\w+)\((.+)\)$/);
  if (match) return { tool: match[1], argPrefix: match[2].replace(/\*$/, "") };
  return { tool: pattern, argPrefix: null };
}

/**
 * Check if a tool request matches a rule pattern.
 *
 * - "Read" matches tool_name === "Read"
 * - "Bash(git *)" matches tool_name === "Bash" AND input.command starts with "git "
 */
function matchesPattern(pattern: string, toolName: string, input: Record<string, unknown>): boolean {
  const { tool, argPrefix } = parsePattern(pattern);
  if (tool !== toolName) return false;
  if (argPrefix === null) return true;

  // Check if any string value in input starts with the prefix
  const command = input.command ?? input.cmd ?? input.script;
  if (typeof command === "string") {
    return command.startsWith(argPrefix);
  }
  return false;
}

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

  async evaluate(request: CanUseToolRequest): Promise<PermissionDecision> {
    switch (this.strategy) {
      case "auto":
        return { allow: true, updatedInput: request.input };

      case "rules":
        return this.evaluateRules(request);

      case "delegate": {
        if (!this.onDelegate) {
          return { allow: false, message: "No delegate callback registered" };
        }
        return this.onDelegate(request);
      }
    }
  }

  private evaluateRules(request: CanUseToolRequest): PermissionDecision {
    const { tool_name, input } = request;
    let hasAllow = false;

    for (const rule of this.rules) {
      if (!matchesPattern(rule.tool, tool_name, input)) continue;

      // Deny takes precedence — return immediately
      if (rule.action === "deny") {
        return {
          allow: false,
          message: `Denied by rule: ${rule.tool}`,
        };
      }
      hasAllow = true;
    }

    if (hasAllow) {
      return { allow: true, updatedInput: input };
    }

    // Fail-closed: no matching rule → deny
    return {
      allow: false,
      message: `No matching rule for tool: ${tool_name}`,
    };
  }
}
