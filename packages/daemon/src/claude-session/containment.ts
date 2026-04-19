// Worktree containment enforcement — see #1441 for design.

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// Resolve symlinks; for non-existent paths, walk up the directory chain until
// realpathSync succeeds, then re-join the missing tail. A single dirname fallback
// is insufficient: if `escape` is a symlink and `newdir` doesn't exist inside
// the target, dirname of the full path still throws (#1481).
function resolveRealpath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    const missingSegments: string[] = [];
    let current = resolve(filePath);
    while (true) {
      const parent = dirname(current);
      if (parent === current) return resolve(filePath);
      missingSegments.unshift(basename(current));
      try {
        return join(realpathSync(parent), ...missingSegments);
      } catch {
        current = parent;
      }
    }
  }
}

// ── Types ──

export type ContainmentAction = "allow" | "deny" | "warn";

export type ContainmentEventType =
  | "session:containment_warning"
  | "session:containment_denied"
  | "session:containment_escalated"
  | "session:containment_reset";

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
  "clone",
  "worktree",
]);

const GIT_CMD_PATTERN = /\bgit\b/;

function extractGitSubcommand(command: string): string | null {
  if (!GIT_CMD_PATTERN.test(command)) return null;

  const tokens = command.split(/[;&|]+/).flatMap((seg) => seg.trim().split(/\s+/));
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    // Skip env var assignments before the command (VAR=val git ...)
    if (tok.includes("=") && !tok.startsWith("-")) continue;
    if (tok !== "git" && !tok.endsWith("/git")) continue;

    let j = i + 1;
    while (j < tokens.length) {
      const t = tokens[j] ?? "";
      if (t === "-C" || t === "--git-dir" || t === "--work-tree") {
        j += 2;
      } else if (t.startsWith("--work-tree=") || t.startsWith("--git-dir=")) {
        j++;
      } else if (t.startsWith("-")) {
        j++;
      } else {
        return t;
      }
    }
  }
  return null;
}

function bashTargetsOutsidePath(command: string, worktreeRoot: string): boolean {
  const outside = (p: string) => isPathOutside(p, worktreeRoot);

  // git -C <path>
  const gitCMatch = command.match(/\bgit\s+-C\s+(\S+)/);
  if (gitCMatch?.[1] && outside(gitCMatch[1])) return true;

  // git --work-tree=<path> or git --work-tree <path>
  const wtEqMatch = command.match(/--work-tree=(\S+)/);
  if (wtEqMatch?.[1] && outside(wtEqMatch[1])) return true;
  const wtSpaceMatch = command.match(/--work-tree\s+(\S+)/);
  if (wtSpaceMatch?.[1] && !wtSpaceMatch[1].startsWith("-") && outside(wtSpaceMatch[1])) return true;

  // git --git-dir=<path> or git --git-dir <path>
  const gdEqMatch = command.match(/--git-dir=(\S+)/);
  if (gdEqMatch?.[1] && outside(gdEqMatch[1])) return true;
  const gdSpaceMatch = command.match(/--git-dir\s+(\S+)/);
  if (gdSpaceMatch?.[1] && !gdSpaceMatch[1].startsWith("-") && outside(gdSpaceMatch[1])) return true;

  // GIT_DIR=<path> or GIT_WORK_TREE=<path> env var prefixes
  const envDirMatch = command.match(/\bGIT_DIR=(\S+)/);
  if (envDirMatch?.[1] && outside(envDirMatch[1])) return true;
  const envWtMatch = command.match(/\bGIT_WORK_TREE=(\S+)/);
  if (envWtMatch?.[1] && outside(envWtMatch[1])) return true;

  // cd / pushd <path> followed by a command separator
  const cdMatch = command.match(/\b(?:cd|pushd)\s+(\S+)\s*[;&|)]/);
  if (cdMatch?.[1] && outside(cdMatch[1]) && GIT_CMD_PATTERN.test(command)) return true;

  // bash -c "cd <path> && ..." or subshell (cd <path> && ...)
  const subshellCdMatch = command.match(/(?:bash\s+-c\s+["']|[(])\s*cd\s+(\S+)/);
  if (subshellCdMatch?.[1] && outside(subshellCdMatch[1]) && GIT_CMD_PATTERN.test(command)) return true;

  return false;
}

// ── Bash file write detection ──
// Known gap: runtime writes (node -e "fs.writeFileSync(...)", bun run script.ts)
// cannot be detected via regex — requires filesystem sandboxing (#1475).

const SHELL_WRITE_CMDS = new Set(["cp", "mv", "tee", "ln", "install", "rsync"]);

function unquote(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function extractBashWriteTargets(command: string): string[] {
  const targets: string[] = [];

  // Shell redirects: > /path or >> /path (only absolute paths)
  for (const m of command.matchAll(/>{1,2}\s*(\/\S+)/g)) {
    if (m[1]) targets.push(m[1]);
  }

  // dd of=/path, of="/path", or of='/path'
  for (const m of command.matchAll(/\bdd\b[^;|&]*\bof=("(\/[^"]*)"|'(\/[^']*)'|(\/\S+))/g)) {
    const target = m[2] ?? m[3] ?? m[4];
    if (target) targets.push(target);
  }

  const segments = command.split(/[;&|]+/);
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/);
    let cmdIdx = 0;
    while (cmdIdx < tokens.length && tokens[cmdIdx]?.includes("=") && !tokens[cmdIdx]?.startsWith("-")) cmdIdx++;
    const cmd = tokens[cmdIdx];
    if (!cmd) continue;

    if (cmd === "sed") {
      const hasDashI = tokens.some(
        (t, i) => i > cmdIdx && (t === "-i" || t === "--in-place" || t.startsWith("--in-place=") || /^-[^-]*i/.test(t)),
      );
      if (hasDashI) {
        let expectsScriptArg = false;
        let sawScript = false;
        let fileArgStart = -1;

        for (let k = cmdIdx + 1; k < tokens.length; k++) {
          const t = tokens[k] ?? "";

          if (expectsScriptArg) {
            expectsScriptArg = false;
            sawScript = true;
            continue;
          }

          if (t === "-e" || t === "-f") {
            expectsScriptArg = true;
            continue;
          }

          if (t.startsWith("--expression=") || t.startsWith("--file=")) {
            sawScript = true;
            continue;
          }

          if (t === "-i" || t === "--in-place" || t.startsWith("--in-place=") || /^-[^-]*i/.test(t)) {
            continue;
          }

          if (t === "--") {
            fileArgStart = k + 1;
            break;
          }

          if (t.startsWith("-")) continue;

          if (!sawScript) {
            sawScript = true;
            continue;
          }

          fileArgStart = k;
          break;
        }

        if (fileArgStart !== -1) {
          for (let k = fileArgStart; k < tokens.length; k++) {
            const raw = tokens[k] ?? "";
            const t = unquote(raw);
            if (t.startsWith("/")) {
              targets.push(t);
              break;
            }
          }
        }
      }
      continue;
    }

    if (cmd === "curl" || cmd === "wget") {
      const outputFlags = cmd === "curl" ? ["-o", "--output"] : ["-O", "--output-document"];
      for (let k = cmdIdx + 1; k < tokens.length; k++) {
        const raw = tokens[k] ?? "";
        for (const flag of outputFlags) {
          if (raw.startsWith(`${flag}=`)) {
            const val = unquote(raw.slice(flag.length + 1));
            if (val.startsWith("/")) targets.push(val);
          }
        }
        if (outputFlags.includes(raw) && k + 1 < tokens.length) {
          const val = unquote(tokens[k + 1] ?? "");
          if (val.startsWith("/")) targets.push(val);
          k++;
        }
      }
      continue;
    }

    if (!SHELL_WRITE_CMDS.has(cmd)) continue;

    // Extract absolute path arguments (skip flags)
    for (let k = cmdIdx + 1; k < tokens.length; k++) {
      const raw = tokens[k] ?? "";
      if (raw.startsWith("-")) continue;
      const t = unquote(raw);
      if (t.startsWith("/")) targets.push(t);
    }
  }

  return targets;
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
  // resolve(worktreeRoot, filePath) handles relative paths against worktreeRoot;
  // resolveRealpath then follows any symlinks so escapes via symlinks are caught (#1481).
  const resolved = resolveRealpath(resolve(worktreeRoot, filePath));
  return !resolved.startsWith(`${worktreeRoot}/`) && resolved !== worktreeRoot;
}

// ── Allowed external paths ──

const ALLOWED_EXTERNAL_PREFIXES = ["/tmp", "/var/tmp", "/private/tmp"];

function isAllowedExternalPath(filePath: string, worktreeRoot: string): boolean {
  const normalized = resolve(worktreeRoot, filePath);
  // Symlink escape: nominal path is inside the worktree but real path is outside.
  // The /tmp exemption must not apply — otherwise a session creates
  // worktree/escape → /tmp/outside and writes freely (#1481).
  if (normalized.startsWith(`${worktreeRoot}/`)) return false;
  // Resolve symlinks before prefix check so /tmp/link → /etc/passwd is not allowed.
  const real = resolveRealpath(normalized);
  return ALLOWED_EXTERNAL_PREFIXES.some((p) => real.startsWith(`${p}/`) || real === p);
}

// ── Guard ──

const MAX_STRIKES = 3;

export class ContainmentGuard {
  readonly worktreeRoot: string;
  private _strikes = 0;
  private _escalated = false;

  constructor(worktreeRoot: string) {
    // Strip trailing slash then resolve symlinks (iterative walk so non-existent paths
    // like /tmp/worktree still resolve /tmp → /private/tmp on macOS).
    this.worktreeRoot = resolveRealpath(worktreeRoot.replace(/\/+$/, ""));
  }

  get strikes(): number {
    return this._strikes;
  }

  get escalated(): boolean {
    return this._escalated;
  }

  /** Reset strikes and escalation state, allowing the session to resume. */
  reset(): void {
    this._strikes = 0;
    this._escalated = false;
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

    // Check git write commands
    const subcommand = extractGitSubcommand(command);
    if (subcommand && GIT_WRITE_SUBCOMMANDS.has(subcommand)) {
      if (bashTargetsOutsidePath(command, this.worktreeRoot)) {
        return {
          action: "deny",
          reason: `Git write command "git ${subcommand}" targets path outside worktree ${this.worktreeRoot}. This is never allowed.`,
          event: "session:containment_denied",
          strikes: this._strikes,
        };
      }
    }

    // Check shell file writes (redirects, cp, mv, tee, ln, etc.)
    const writeTargets = extractBashWriteTargets(command);
    for (const target of writeTargets) {
      if (isAllowedExternalPath(target, this.worktreeRoot)) continue;
      if (isPathOutside(target, this.worktreeRoot)) {
        return this.evaluateFileAccess("Bash", target);
      }
    }

    return { action: "allow", reason: "", strikes: this._strikes };
  }

  private evaluateFileAccess(toolName: string, filePath: string): ContainmentResult {
    const resolved = resolveRealpath(resolve(this.worktreeRoot, filePath));

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
    // Allow /tmp writes without penalty (symlink escapes excluded via worktreeRoot guard)
    if (isAllowedExternalPath(filePath, this.worktreeRoot)) {
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
