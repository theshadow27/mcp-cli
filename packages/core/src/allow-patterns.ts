/**
 * Unified permission-pattern resolution for --allow / --allow-only.
 *
 * Single source of truth consumed by CLI parsers (spawn, claude resume,
 * agent resume) and the session worker. Covers:
 *   1. Comma-split normalization
 *   2. Dead-pattern detection (errors, not warnings)
 *   3. DEFAULT_SAFE_TOOLS union / allow-only semantics
 *   4. Mutual-exclusivity of --allow vs --allow-only
 */

// ── Defaults ──

export const DEFAULT_SAFE_TOOLS: readonly string[] = Object.freeze(["Read", "Glob", "Grep", "Write", "Edit"]);

// ── Heuristic ──

/**
 * Does a string look like a tool name / pattern for --allow?
 * Tool names are PascalCase (Read, WebSearch), MCP-style (mcp__echo__add),
 * or contain wildcards (*). Worktree names and session IDs are typically
 * lowercase-kebab or hex strings.
 */
export function looksLikeToolName(s: string): boolean {
  if (s.startsWith("-")) return false;
  if (s.includes("*")) return true;
  if (s.startsWith("mcp_")) return true;
  if (/^[A-Z]/.test(s)) return true;
  return false;
}

// ── Validation ──

export interface AllowValidation {
  patterns: string[];
  errors: string[];
  warnings: string[];
}

/**
 * Normalize and validate raw --allow values.
 *
 * - Splits comma-separated entries ("Bash,Write" → ["Bash", "Write"]) with a warning
 * - Detects dead patterns like Bash(*) — these are ERRORS because a permission
 *   rule that matches nothing is a misconfiguration, not a footgun to warn about
 * - Detects missing :* suffix in prefix wildcards
 */
export function validateAllowPatterns(rawValues: string[]): AllowValidation {
  const patterns: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const raw of rawValues) {
    if (raw.includes(",")) {
      warnings.push(
        `Comma-separated --allow pattern "${raw}" was split into ${raw.split(",").length} patterns — use spaces instead`,
      );
      for (const part of raw.split(",")) {
        const trimmed = part.trim();
        if (trimmed) patterns.push(trimmed);
      }
    } else {
      patterns.push(raw);
    }
  }

  for (const pattern of patterns) {
    const parenMatch = pattern.match(/^(\w+)\((.+)\)$/);
    if (parenMatch) {
      const toolName = parenMatch[1];
      const inner = parenMatch[2];
      if (inner === "*") {
        errors.push(
          `"${pattern}" is a dead rule — bare (*) is not a wildcard. Use "${toolName}" (no parens) to allow all ${toolName} calls, or "${toolName}(:*)" for prefix matching`,
        );
      } else if (inner.endsWith("*") && !inner.endsWith(":*")) {
        warnings.push(
          `"${pattern}" may not match as expected — use ":*" suffix for prefix wildcards (e.g. "${toolName}(${inner.slice(0, -1)}:*)")`,
        );
      }
    }
  }

  return { patterns, errors, warnings };
}

// ── Resolution ──

export interface ResolveEffectiveToolsOpts {
  allowedTools?: string[];
  allowOnly?: boolean;
  permissionMode?: string;
}

/**
 * Compute the final resolved tool set for a session.
 *
 * - permissionMode !== "rules" → undefined (no tool restrictions)
 * - allowOnly + no allowedTools → error (empty string[] returned, caller should reject)
 * - allowOnly + allowedTools → exactly those tools (no defaults)
 * - allowedTools without allowOnly → union with DEFAULT_SAFE_TOOLS
 * - no allowedTools → DEFAULT_SAFE_TOOLS
 */
export function resolveEffectiveTools(opts: ResolveEffectiveToolsOpts): {
  tools: string[] | undefined;
  error?: string;
} {
  const { allowedTools, allowOnly = false, permissionMode = "rules" } = opts;

  if (permissionMode !== "rules") return { tools: undefined };

  if (allowOnly) {
    if (!allowedTools || allowedTools.length === 0) {
      return {
        tools: undefined,
        error: "allowOnly requires at least one tool in allowedTools",
      };
    }
    return { tools: [...allowedTools] };
  }

  if (allowedTools && allowedTools.length > 0) {
    return { tools: [...new Set([...DEFAULT_SAFE_TOOLS, ...allowedTools])] };
  }

  return { tools: [...DEFAULT_SAFE_TOOLS] };
}
