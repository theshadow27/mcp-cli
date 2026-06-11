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

import type { AgentPermissionRequest, AgentSessionEvent, ContainmentGuard, ContainmentResult } from "@mcp-cli/core";
import { gateContainment } from "@mcp-cli/core";
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
 * Gate a Codex approval against the worktree containment guard.
 *
 * A Codex `fileChange` patch can touch multiple files, surfaced as
 * `input.files`. Checking only `files[0]` (the guard's single-path view) lets
 * an out-of-worktree path in any later entry bypass containment (#2519), so
 * every path is validated and the first escape denies the whole patch. A
 * change set that is empty or carries a non-string path fails closed rather
 * than being silently approved. Non-fileChange approvals (command execution)
 * fall through to the guard's normal single-call evaluation.
 */
export function gateApprovalContainment(
  guard: ContainmentGuard | null,
  permission: AgentPermissionRequest,
  emit: (event: AgentSessionEvent) => void,
): ContainmentResult | null {
  if (!guard) return null;

  const files = permission.input.files;
  if (Array.isArray(files)) {
    if (files.length === 0) {
      const reason = `Codex file-change approval has no resolvable file paths; containment cannot verify it stays inside ${guard.worktreeRoot}. Denied.`;
      emit({ type: "session:containment_denied", toolName: permission.toolName, reason, strikes: guard.strikes });
      return { action: "deny", reason, strikes: guard.strikes };
    }
    for (const file of files) {
      if (typeof file !== "string") {
        const reason = `Codex file-change approval contains a non-string file path; containment cannot verify it stays inside ${guard.worktreeRoot}. Denied.`;
        emit({ type: "session:containment_denied", toolName: permission.toolName, reason, strikes: guard.strikes });
        return { action: "deny", reason, strikes: guard.strikes };
      }
      const result = gateContainment(guard, "Write", { file_path: file }, emit);
      if (result?.action === "deny") return result;
    }
    return { action: "allow", reason: "", strikes: guard.strikes };
  }

  return gateContainment(guard, permission.toolName, permission.input, emit);
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
