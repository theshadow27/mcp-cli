/**
 * Translates ACP permission requests into the PermissionRequest format
 * used by @mcp-cli/permissions.
 *
 * ACP's session/request_permission includes options with optionId values.
 * We evaluate against the shared rule engine and pick the appropriate option.
 *
 * Mirrors codex-permission-adapter.ts.
 */

import type { AgentPermissionRequest } from "@mcp-cli/core";
import { type PermissionDecision, type PermissionRequest, type PermissionRule, evaluate } from "@mcp-cli/permissions";
import type { PermissionRequestParams } from "./schemas";

export interface AcpAdapterDecision {
  /** Whether the rule engine produced a definitive answer. */
  resolved: boolean;
  /** True if allowed (only meaningful when resolved=true). */
  allow: boolean;
  /** Whether to use allow_always (persistent) or allow_once. */
  persistent: boolean;
  /** The permission request in canonical format. */
  request: PermissionRequest;
}

/**
 * Map ACP permission request params to an AgentPermissionRequest.
 */
export function mapPermissionRequest(params: PermissionRequestParams): AgentPermissionRequest {
  // Determine tool name from the request context
  const toolName = params.tool ?? (params.command ? "Bash" : params.path ? "Write" : "unknown");
  const input: Record<string, unknown> = {};

  if (params.command) input.command = params.command;
  if (params.path) input.file_path = params.path;

  const summary = params.description ?? params.command ?? params.path ?? "ACP permission request";

  return {
    requestId: "", // Will be set by the session using the JSON-RPC id
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
): AcpAdapterDecision {
  const request: PermissionRequest = {
    toolName: permissionRequest.toolName,
    input: permissionRequest.input,
  };

  if (rules.length === 0) {
    return { resolved: false, allow: false, persistent: false, request };
  }

  const decision: PermissionDecision = evaluate(rules, request);

  // If no rule matched, escalate to manual review
  if (!decision.allow && decision.message?.startsWith("No matching rule")) {
    return { resolved: false, allow: false, persistent: false, request };
  }

  return {
    resolved: true,
    allow: decision.allow,
    // If the rule explicitly allows, use allow_always to reduce future prompts
    persistent: decision.allow,
    request,
  };
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

/**
 * Find the optionId matching the desired decision kind.
 */
export function findOptionId(
  options: ReadonlyArray<{ optionId: string; kind: string }>,
  kind: string,
): string | undefined {
  return options.find((o) => o.kind === kind)?.optionId;
}
