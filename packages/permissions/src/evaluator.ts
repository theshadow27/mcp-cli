/**
 * Core permission evaluation engine.
 *
 * Evaluates a set of rules against a permission request.
 * Semantics:
 * - Deny rules take precedence (first deny wins)
 * - Then allow rules (first allow wins)
 * - Fail-closed: no matching rule → deny
 */

import { matchBashCommand } from "./bash-matcher";
import { matchFilePath } from "./file-matcher";
import {
  type PermissionRule,
  isToolWildcard,
  isWildcardPattern,
  parsePattern,
  toArgPrefix,
  toToolPrefix,
} from "./rule";

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
}

export interface PermissionDecision {
  allow: boolean;
  /** Whether a rule matched. False means fail-closed (no rule matched). */
  matched: boolean;
  message?: string;
  updatedInput?: Record<string, unknown>;
}

/**
 * Extract the command string from a Bash-like tool input.
 * Checks `command`, `cmd`, and `script` fields.
 */
function extractCommand(input: Record<string, unknown>): string | null {
  const command = input.command ?? input.cmd ?? input.script;
  return typeof command === "string" ? command : null;
}

/**
 * Extract the file path from a file-tool input.
 * Checks `file_path`, `path`, and `filePath` fields.
 */
function extractFilePath(input: Record<string, unknown>): string | null {
  const fp = input.file_path ?? input.path ?? input.filePath;
  return typeof fp === "string" ? fp : null;
}

/**
 * Check if a permission request matches a rule pattern.
 */
function matchesRule(rule: PermissionRule, request: PermissionRequest): boolean {
  const { tool, argPattern } = parsePattern(rule.tool);

  // Tool name matching: exact or tool-wildcard (__*)
  if (isToolWildcard(tool)) {
    if (!request.toolName.startsWith(toToolPrefix(tool))) return false;
  } else {
    if (tool !== request.toolName) return false;
  }
  if (argPattern === null) return true;

  // For Bash-like tools, match against the command
  if (tool === "Bash") {
    const command = extractCommand(request.input);
    if (command === null) return false;
    // Exact match when no wildcard, prefix match when wildcard
    if (!isWildcardPattern(argPattern)) return command === argPattern;
    return matchBashCommand(command, toArgPrefix(argPattern));
  }

  // For file tools (Read, Write, Edit), match against the file path using glob
  if (tool === "Read" || tool === "Write" || tool === "Edit") {
    const filePath = extractFilePath(request.input);
    if (filePath === null) return false;
    return matchFilePath(filePath, argPattern);
  }

  // For unknown tools with argPattern, fall back to command extraction
  const command = extractCommand(request.input);
  if (command !== null) {
    if (!isWildcardPattern(argPattern)) return command === argPattern;
    return matchBashCommand(command, toArgPrefix(argPattern));
  }

  return false;
}

/**
 * Evaluate a set of permission rules against a request.
 *
 * Semantics:
 * 1. Check all deny rules first — first match returns deny
 * 2. Check all allow rules — first match returns allow
 * 3. No match → fail-closed (deny)
 */
export function evaluate(rules: readonly PermissionRule[], request: PermissionRequest): PermissionDecision {
  let hasAllow = false;

  for (const rule of rules) {
    if (!matchesRule(rule, request)) continue;

    // Deny takes precedence — return immediately
    if (rule.action === "deny") {
      return {
        allow: false,
        matched: true,
        message: `Denied by rule: ${rule.tool}`,
      };
    }
    hasAllow = true;
  }

  if (hasAllow) {
    return { allow: true, matched: true, updatedInput: request.input };
  }

  // Fail-closed: no matching rule → deny
  return {
    allow: false,
    matched: false,
    message: `No matching rule for tool: ${request.toolName}`,
  };
}
