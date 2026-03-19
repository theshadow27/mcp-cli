/**
 * Translates Codex approval requests into the PermissionRequest format
 * used by @mcp-cli/permissions.
 *
 * This adapter bridges two worlds:
 * - Codex sends `commandExecution/requestApproval` and `fileChange/requestApproval`
 * - Our rules engine evaluates `{ toolName: "Bash", input: { command } }`
 *
 * The same allowedTools config (e.g. "Bash(npm run *)") works for both
 * Claude and Codex sessions.
 */

import type { AgentPermissionRequest } from "@mcp-cli/core";
import { type PermissionDecision, type PermissionRequest, type PermissionRule, evaluate } from "@mcp-cli/permissions";

export interface AdapterDecision {
  /** Whether the rule engine produced a definitive answer. */
  resolved: boolean;
  /** True if allowed (only meaningful when resolved=true). */
  allow: boolean;
  /** The permission request in Claude format (for logging/delegation). */
  request: PermissionRequest;
}

/**
 * Evaluate an AgentPermissionRequest against permission rules.
 *
 * The AgentPermissionRequest is already in the right shape —
 * toolName maps to rule tool names, input contains the relevant fields.
 */
export function evaluateApproval(
  permissionRequest: AgentPermissionRequest,
  rules: readonly PermissionRule[],
): AdapterDecision {
  const request: PermissionRequest = {
    toolName: permissionRequest.toolName,
    input: permissionRequest.input,
  };

  if (rules.length === 0) {
    // No rules → fail-closed, needs manual review
    return { resolved: false, allow: false, request };
  }

  const decision: PermissionDecision = evaluate(rules, request);

  // If no rule matched (neither allow nor explicit deny), escalate to manual review
  // rather than silently denying. This ensures new tool types aren't blocked invisibly.
  if (!decision.matched) {
    return { resolved: false, allow: false, request };
  }

  return { resolved: true, allow: decision.allow, request };
}

/**
 * Convert allowedTools strings into PermissionRule array.
 *
 * Allow entries become `{ tool, action: "allow" }`.
 * Deny entries become `{ tool, action: "deny" }`.
 * Deny rules are placed first so they take precedence.
 */
export function buildRules(allowedTools?: readonly string[], disallowedTools?: readonly string[]): PermissionRule[] {
  const rules: PermissionRule[] = [];

  if (disallowedTools) {
    for (const tool of disallowedTools) {
      rules.push({ tool, action: "deny" });
    }
  }
  if (allowedTools) {
    for (const tool of allowedTools) {
      rules.push({ tool, action: "allow" });
    }
  }

  return rules;
}
