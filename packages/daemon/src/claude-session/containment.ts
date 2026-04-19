/**
 * Worktree containment enforcement for Claude Code sessions.
 *
 * Intercepts can_use_tool permission requests and applies tiered policy:
 * - Git writes outside worktree → hard deny (first attempt)
 * - Write/Edit outside worktree → strike-counted (3-strike cap → hard stop)
 * - Read/cd outside worktree → warn only (no strike)
 *
 * See #1441 for design rationale.
 */

import { resolve } from "node:path";

// ── Types ──

export type ContainmentAction = "allow" | "deny" | "warn";

export type ContainmentEventType =
  | "session:containment_warning"
  | "session:containment_denied"
  | "session:containment_escalated";

export interface ContainmentResult {
  action: ContainmentAction;
  reason: string;
  event?: ContainmentEventType;
  /** Current gray-zone strike count after this evaluation. */
  strikes: number;
}

// ── Git command classification ──

const GIT_WRITE_SUBCOMMANDS = new Set([
  "add",
  "checkout",
  "commit",
  "merge",
  "rebase",
  "reset",
  "push",
  "branch",
  "cherry-pick",
  "stash",
  "tag",
  "revert",
  "am",
  "mv",
  "rm",
  "switch",
  "restore",
]);

const GIT_CMD_PATTERN = /\bgit\b/;

/**
 * Extract the git subcommand from a shell command string.
 * Handles: git commit, git -C /path commit, git --no-pager commit, etc.
 * Returns null if not a git command or subcommand is unrecognized.
 */
function extractGitSubcommand(command: string): string | null {
  if (!GIT_CMD_PATTERN.test(command)) return null;

  // Tokenize naively — good enough for detecting subcommands.
  // We don't need a full shell parser; false negatives are acceptable
  // (the GIT_DIR/GIT_WORK_TREE env pinning is the true guardrail).
  const tokens = command.split(/[;&|]+/).flatMap((seg) => seg.trim().split(/\s+/));
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "git" && !tokens[i]?.endsWith("/git")) continue;

    // Skip flags and -C/--git-dir arguments after "git"
    let j = i + 1;
    while (j < tokens.length) {
      const tok = tokens[j] ?? "";
      if (tok === "-C" || tok === "--git-dir" || tok === "--work-tree") {
        j += 2; // skip flag + its argument
      } else if (tok.startsWith("-")) {
        j++;
      } else {
        return tok;
      }
    }
  }
  return null;
}

/**
 * Check whether a Bash command explicitly targets a path outside the worktree
 * via `git -C <path>` or `cd <path> &&`.
 */
function bashTargetsOutsidePath(command: string, worktreeRoot: string): boolean {
  // git -C <path>
  const gitCMatch = command.match(/\bgit\s+-C\s+(\S+)/);
  if (gitCMatch?.[1]) {
    const target = resolve(gitCMatch[1]);
    if (!target.startsWith(worktreeRoot)) return true;
  }

  // cd <path> && git ...
  const cdMatch = command.match(/\bcd\s+(\S+)\s*[;&|]/);
  if (cdMatch?.[1]) {
    const target = resolve(cdMatch[1]);
    if (!target.startsWith(worktreeRoot) && GIT_CMD_PATTERN.test(command)) return true;
  }

  return false;
}

// ── File path extraction ──

function extractFilePath(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === "Write" || toolName === "Edit" || toolName === "Read") {
    const fp = input.file_path;
    return typeof fp === "string" ? fp : null;
  }
  if (toolName === "Glob" || toolName === "Grep") {
    const p = input.path;
    return typeof p === "string" ? p : null;
  }
  return null;
}

function isPathOutside(filePath: string, worktreeRoot: string): boolean {
  const resolved = resolve(filePath);
  return !resolved.startsWith(`${worktreeRoot}/`) && resolved !== worktreeRoot;
}

// ── Allowed external paths ──

const ALLOWED_EXTERNAL_PREFIXES = ["/tmp", "/var/tmp", "/private/tmp"];

function isAllowedExternalPath(filePath: string): boolean {
  const resolved = resolve(filePath);
  return ALLOWED_EXTERNAL_PREFIXES.some((p) => resolved.startsWith(`${p}/`) || resolved === p);
}

// ── Guard ──

const MAX_STRIKES = 3;

export class ContainmentGuard {
  readonly worktreeRoot: string;
  private _strikes = 0;
  private _escalated = false;

  constructor(worktreeRoot: string) {
    // Normalize: strip trailing slash for consistent prefix comparison
    this.worktreeRoot = worktreeRoot.replace(/\/+$/, "");
  }

  get strikes(): number {
    return this._strikes;
  }

  get escalated(): boolean {
    return this._escalated;
  }

  /**
   * Evaluate a tool call against containment policy.
   * Returns allow for in-worktree operations or when no worktree is set.
   */
  evaluate(toolName: string, input: Record<string, unknown>): ContainmentResult {
    if (this._escalated) {
      return {
        action: "deny",
        reason: "Session escalated: containment limit reached (3 strikes). All tool calls denied.",
        event: "session:containment_escalated",
        strikes: this._strikes,
      };
    }

    // Bash tool — check for git write commands outside worktree
    if (toolName === "Bash") {
      return this.evaluateBash(input);
    }

    // File-path tools
    const filePath = extractFilePath(toolName, input);
    if (filePath && isPathOutside(filePath, this.worktreeRoot)) {
      return this.evaluateFileAccess(toolName, filePath);
    }

    return { action: "allow", reason: "", strikes: this._strikes };
  }

  private evaluateBash(input: Record<string, unknown>): ContainmentResult {
    const command = typeof input.command === "string" ? input.command : "";
    if (!command) return { action: "allow", reason: "", strikes: this._strikes };

    const subcommand = extractGitSubcommand(command);
    if (!subcommand) return { action: "allow", reason: "", strikes: this._strikes };

    // Only enforce on git write subcommands
    if (!GIT_WRITE_SUBCOMMANDS.has(subcommand)) {
      return { action: "allow", reason: "", strikes: this._strikes };
    }

    // Check if the command explicitly targets outside the worktree
    if (bashTargetsOutsidePath(command, this.worktreeRoot)) {
      return {
        action: "deny",
        reason: `Git write command "git ${subcommand}" targets path outside worktree ${this.worktreeRoot}. This is never allowed.`,
        event: "session:containment_denied",
        strikes: this._strikes,
      };
    }

    // Git write commands without explicit external path are allowed —
    // the GIT_DIR/GIT_WORK_TREE env vars pin git to the worktree.
    return { action: "allow", reason: "", strikes: this._strikes };
  }

  private evaluateFileAccess(toolName: string, filePath: string): ContainmentResult {
    const resolved = resolve(filePath);

    // Read-class tools: warn only, no strike
    if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
      return {
        action: "warn",
        reason: `${toolName} targets ${resolved} outside worktree ${this.worktreeRoot}. Reads are allowed but monitored.`,
        event: "session:containment_warning",
        strikes: this._strikes,
      };
    }

    // Write/Edit: strike-counted gray zone
    // Allow /tmp writes without penalty
    if (isAllowedExternalPath(filePath)) {
      return { action: "allow", reason: "", strikes: this._strikes };
    }

    this._strikes++;
    if (this._strikes >= MAX_STRIKES) {
      this._escalated = true;
      return {
        action: "deny",
        reason: `${toolName} targets ${resolved} outside worktree ${this.worktreeRoot}. Strike ${this._strikes}/${MAX_STRIKES} — session escalated. All further tool calls will be denied.`,
        event: "session:containment_escalated",
        strikes: this._strikes,
      };
    }

    return {
      action: "deny",
      reason: `${toolName} targets ${resolved} outside worktree ${this.worktreeRoot}. Strike ${this._strikes}/${MAX_STRIKES}. Write/Edit outside worktree is denied.`,
      event: "session:containment_denied",
      strikes: this._strikes,
    };
  }
}
