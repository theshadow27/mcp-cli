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
import {
  type PermissionDecision,
  type PermissionRequest,
  type PermissionRule,
  assertValidRules,
  evaluate,
} from "@mcp-cli/permissions";
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
 *
 * Two shapes are supported:
 *  - Flat (copilot/gemini/grok): `tool` / `command` / `path` fields.
 *  - Kiro: the call is under `toolCall` and the semantics under `_meta.kiro`
 *    (`toolId`, `consent.capability`, `command`). Kiro's coarse capability is
 *    mapped to the Claude-style tool names the rule engine + DEFAULT_SAFE_TOOLS
 *    speak (`shell`→Bash, `fsRead`/read→Read, `fsWrite`/write→Write), so an
 *    `--allow Bash`/`Read`/`Write` rule matches a kiro run_command / file tool.
 *    Without this mapping every kiro tool maps to "unknown" and fail-closes.
 */
export function mapPermissionRequest(params: PermissionRequestParams): AgentPermissionRequest {
  const kiro = params._meta?.kiro;
  if (kiro || params.toolCall) {
    return mapKiroPermissionRequest(params);
  }

  // Flat shape (copilot/gemini/grok)
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

/** Map kiro's capability/toolId to a Claude-style tool name the rule engine understands. */
function kiroCapabilityToToolName(capability: string | undefined, toolId: string | undefined): string {
  const c = capability?.toLowerCase();
  if (c === "shell" || toolId === "run_command" || toolId === "execute_bash") return "Bash";
  if (c === "fswrite" || c === "write" || toolId?.startsWith("fs_write") || toolId === "write_file") return "Write";
  if (c === "fsread" || c === "read" || toolId?.startsWith("fs_read") || toolId === "read_file") return "Read";
  // Fall back to the kiro toolId itself so an explicit `--allow <toolId>` rule can match.
  return toolId ?? "unknown";
}

/** Map a kiro `session/request_permission` (toolCall + _meta.kiro) into the rule-engine shape. */
function mapKiroPermissionRequest(params: PermissionRequestParams): AgentPermissionRequest {
  const kiro = params._meta?.kiro;
  const toolName = kiroCapabilityToToolName(kiro?.consent?.capability, kiro?.toolId);
  const command = kiro?.command ?? params.toolCall?.title;
  const resource = kiro?.consent?.resource;

  const input: Record<string, unknown> = {};
  if (toolName === "Bash" && command) {
    input.command = command;
  } else if ((toolName === "Read" || toolName === "Write") && resource) {
    input.file_path = resource;
  } else if (command) {
    // Unknown/other kiro tool — expose the command so a bare tool-name rule still matches.
    input.command = command;
  }

  const summary = params.toolCall?.title ?? command ?? resource ?? `kiro ${kiro?.toolId ?? "tool"}`;

  return {
    requestId: "",
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
  if (!decision.matched) {
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

  assertValidRules(rules);
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
