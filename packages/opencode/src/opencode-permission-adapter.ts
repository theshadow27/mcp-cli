/**
 * Translates OpenCode permission requests into the PermissionRequest format
 * used by @mcp-cli/permissions.
 *
 * Two directions:
 * 1. Runtime evaluation: when `permission.asked` arrives, evaluate using shared rules
 * 2. Decision mapping: translate evaluation result to OpenCode reply format
 *
 * Tool name mapping:
 * | OpenCode permission | mcp-cli toolName |
 * |--------------------|-----------------|
 * | bash               | Bash            |
 * | edit/write/multiedit/apply_patch | Write |
 * | read               | Read            |
 * | webfetch/websearch  | WebFetch       |
 * | glob               | Glob            |
 * | grep               | Grep            |
 * | list               | Glob            |
 */

import type { AgentPermissionRequest } from "@mcp-cli/core";
import { type PermissionDecision, type PermissionRequest, type PermissionRule, evaluate } from "@mcp-cli/permissions";

/** Map OpenCode permission names to mcp-cli tool names. */
const PERMISSION_MAP: Record<string, string> = {
  bash: "Bash",
  edit: "Write",
  write: "Write",
  multiedit: "Write",
  apply_patch: "Write",
  read: "Read",
  webfetch: "WebFetch",
  websearch: "WebFetch",
  glob: "Glob",
  grep: "Grep",
  list: "Glob",
};

export interface OpenCodeAdapterDecision {
  /** Whether the rule engine produced a definitive answer. */
  resolved: boolean;
  /** True if allowed (only meaningful when resolved=true). */
  allow: boolean;
  /** The reply to send to OpenCode: "once", "always", or "reject". */
  reply: "once" | "always" | "reject";
  /** The permission request in canonical format. */
  request: PermissionRequest;
}

/**
 * Map an OpenCode permission.asked event to an AgentPermissionRequest.
 */
export function mapPermissionRequest(data: Record<string, unknown>): AgentPermissionRequest {
  const permission = data.permission as string;
  const metadata = (data.metadata as Record<string, unknown>) ?? {};
  const patterns = (data.patterns as string[]) ?? [];

  const toolName = PERMISSION_MAP[permission] ?? capitalize(permission);
  const input: Record<string, unknown> = { ...metadata };

  // Build a human-readable summary
  const summary = patterns.length > 0 ? `${permission}: ${patterns.join(", ")}` : `${permission} request`;

  return {
    requestId: "", // Set by session using the SSE event id
    toolName,
    input,
    inputSummary: summary,
  };
}

/**
 * Evaluate an AgentPermissionRequest against permission rules.
 */
export function evaluatePermission(
  permissionRequest: AgentPermissionRequest,
  rules: readonly PermissionRule[],
): OpenCodeAdapterDecision {
  const request: PermissionRequest = {
    toolName: permissionRequest.toolName,
    input: permissionRequest.input,
  };

  if (rules.length === 0) {
    return { resolved: false, allow: false, reply: "reject", request };
  }

  const decision: PermissionDecision = evaluate(rules, request);

  if (!decision.matched) {
    return { resolved: false, allow: false, reply: "reject", request };
  }

  if (decision.allow) {
    return { resolved: true, allow: true, reply: "always", request };
  }

  return { resolved: true, allow: false, reply: "reject", request };
}

/**
 * Convert allowedTools strings into PermissionRule array.
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

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
