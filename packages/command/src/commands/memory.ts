/**
 * `mcx memory audit` — Haiku-driven contradiction + staleness check.
 *
 * Reads .claude/memory/ files + MEMORY.md index, passes them along with
 * recently-closed GitHub issues to Haiku, and reports rules that look
 * stale, contradictory, or superseded.
 *
 * Usage:
 *   mcx memory audit              Print human-readable report
 *   mcx memory audit --json       Machine-readable JSON (for retro-skill)
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveModelName, resolveSourceClaudePath } from "@mcp-cli/core";
import { printError } from "../output";

// ─── Types ───────────────────────────────────────────────────────────────────

export type AuditStatus = "load-bearing" | "stale" | "contradicts" | "superseded-by";

export interface AuditFinding {
  file: string;
  status: AuditStatus;
  reason: string;
  /** The other rule's file ID when status is "contradicts" or "superseded-by". */
  related: string | null;
}

export interface AuditResult {
  findings: AuditFinding[];
  top_prune_candidates: string[];
}

export interface MemoryDeps {
  /** Resolve the git repo root. Returns null if not in a git repo. */
  getGitRoot: () => string | null;
  /** Current working directory. */
  cwd: () => string;
  /** Check whether a directory exists. */
  dirExists: (path: string) => boolean;
  /** Spawn a process and capture stdout/stderr/exitCode. Never throws. */
  spawnCapture: (cmd: string[], opts?: { input?: string }) => { stdout: string; stderr: string; exitCode: number };
  /** Write content to a temp file and return the path. */
  writeTempFile: (content: string) => string;
  /** Read a file. Returns null if it doesn't exist or is unreadable. */
  readFile: (path: string) => string | null;
  /** List files in a directory matching an extension. Returns [] if dir missing. */
  listFiles: (dir: string, ext: string) => string[];
  /** Resolve the claude binary path. Returns null if not found. */
  findClaudeBinary: () => string | null;
  log: (msg: string) => void;
  logError: (msg: string) => void;
  exit: (code: number) => never;
}

const HAIKU_MODEL = resolveModelName("haiku");

const AUDIT_PROMPT = `You are auditing a project's persistent memory rules. Rules are stored as markdown files in .claude/memory/ and indexed in MEMORY.md.

For each rule file provided in the input below, classify it as one of:
- load-bearing: still actively needed, accurate, no issues
- stale: the issue it references has been closed and the fix shipped, or the behavior it describes no longer applies
- contradicts: conflicts with another rule in a meaningful way (set "related" to the conflicting file name)
- superseded-by: another rule already covers the same ground more accurately (set "related" to the superseding file name)

## MEMORY.md index:

{MEMORY_MD}

## Rule file contents:

{RULE_FILES}

## Recently closed GitHub issues (last 50):

{CLOSED_ISSUES}

## Response format

Respond with ONLY valid JSON — no prose before or after:
{
  "findings": [
    {
      "file": "<filename.md>",
      "status": "load-bearing" | "stale" | "contradicts" | "superseded-by",
      "reason": "<1-2 sentence explanation>",
      "related": "<other-file.md or null>"
    }
  ],
  "top_prune_candidates": ["<file1.md>", "<file2.md>"]
}

The top_prune_candidates list should contain 3-5 files most worth pruning (stale or superseded). If none are worth pruning, return an empty array.`;

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Find the .claude/memory directory relative to the git root (or cwd if not in a repo).
 */
export function findMemoryDir(deps: Pick<MemoryDeps, "getGitRoot" | "cwd" | "dirExists">): string | null {
  const root = deps.getGitRoot() ?? deps.cwd();
  const candidate = join(root, ".claude", "memory");
  return deps.dirExists(candidate) ? candidate : null;
}

/**
 * Build the prompt for Haiku by assembling all memory file contents.
 */
export function buildPrompt(
  memoryIndex: string,
  ruleFiles: Array<{ name: string; content: string }>,
  closedIssues: string,
): string {
  const rulesBlock = ruleFiles.map((f) => `### ${f.name}\n\n${f.content}`).join("\n\n---\n\n");

  return AUDIT_PROMPT.replace("{MEMORY_MD}", memoryIndex)
    .replace("{RULE_FILES}", rulesBlock || "(no rule files found)")
    .replace("{CLOSED_ISSUES}", closedIssues || "(unavailable)");
}

/**
 * Call claude --print with the given prompt and model, return stdout or null on failure.
 */
function callHaiku(prompt: string, deps: MemoryDeps): string | null {
  const binary = deps.findClaudeBinary();
  if (!binary) {
    deps.logError("memory audit: claude binary not found — install claude or set MCX_CLAUDE_BINARY");
    return null;
  }

  const result = deps.spawnCapture([binary, "--print", "--model", HAIKU_MODEL], { input: prompt });

  if (result.exitCode !== 0) {
    const stderrMsg = result.stderr.trim();
    deps.logError(`memory audit: claude exited with code ${result.exitCode}${stderrMsg ? `: ${stderrMsg}` : ""}`);
    return null;
  }

  if (result.stderr.trim()) {
    deps.logError(`memory audit: claude stderr: ${result.stderr.trim()}`);
  }

  return result.stdout;
}

/**
 * Fetch the last N closed GitHub issues as a newline-delimited summary for prompt inclusion.
 */
function fetchClosedIssues(deps: MemoryDeps, limit = 50): string {
  const result = deps.spawnCapture([
    "gh",
    "issue",
    "list",
    "--state",
    "closed",
    "--limit",
    String(limit),
    "--json",
    "number,title,closedAt",
  ]);
  if (result.exitCode !== 0) return "(gh unavailable)";
  try {
    const issues = JSON.parse(result.stdout) as Array<{ number: number; title: string; closedAt: string }>;
    return issues.map((i) => `#${i.number}: ${i.title} (closed ${i.closedAt.slice(0, 10)})`).join("\n");
  } catch {
    return "(parse error)";
  }
}

/**
 * Parse Haiku's response, stripping markdown fences if present.
 */
export function parseHaikuResponse(raw: string): AuditResult | null {
  const trimmed = raw.trim();
  // Strip ```json ... ``` fences if present
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  const jsonStr = fenced ? fenced[1].trim() : trimmed;
  // Find the first { to skip any leading prose
  const start = jsonStr.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(jsonStr.slice(start)) as AuditResult;
  } catch {
    return null;
  }
}

export async function runMemoryAudit(opts: { json: boolean }, deps: MemoryDeps): Promise<void> {
  const memoryDir = findMemoryDir(deps);
  if (!memoryDir) {
    deps.logError("memory audit: .claude/memory/ directory not found. Run from a project with Claude Code memory.");
    deps.exit(1);
  }

  deps.logError("memory audit: reading memory files…");

  // Read MEMORY.md index
  const gitRoot = deps.getGitRoot() ?? deps.cwd();
  const memoryIndexPath = join(gitRoot, ".claude", "memory", "MEMORY.md");
  const memoryIndex = deps.readFile(memoryIndexPath) ?? "(MEMORY.md not found)";

  // Read all *.md files in the memory dir (excluding MEMORY.md itself)
  const mdFiles = deps.listFiles(memoryDir, ".md").filter((f) => f !== "MEMORY.md");
  const ruleFiles: Array<{ name: string; content: string }> = [];
  for (const name of mdFiles) {
    const content = deps.readFile(join(memoryDir, name));
    if (content !== null) ruleFiles.push({ name, content });
  }

  deps.logError(`memory audit: ${ruleFiles.length} rule files, fetching closed issues…`);
  const closedIssues = fetchClosedIssues(deps);

  deps.logError("memory audit: calling Haiku…");
  const prompt = buildPrompt(memoryIndex, ruleFiles, closedIssues);
  const rawResponse = callHaiku(prompt, deps);

  if (!rawResponse) {
    deps.logError("memory audit: claude returned empty response");
    deps.exit(1);
  }

  const result = parseHaikuResponse(rawResponse);
  if (!result) {
    const head = rawResponse.slice(0, 50);
    const tail = rawResponse.length > 100 ? rawResponse.slice(-50) : "";
    const preview = tail ? `${head}…${tail}` : head;
    deps.logError(`memory audit: failed to parse Haiku response (${rawResponse.length} chars)`);
    deps.logError(`  preview: ${preview}`);
    try {
      const tmpPath = deps.writeTempFile(rawResponse);
      deps.logError(`  full response saved to: ${tmpPath}`);
    } catch {
      // disk full / permissions — preview above is the best we can do
    }
    deps.exit(1);
  }

  if (opts.json) {
    deps.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human-readable output
  const statusSymbol: Record<AuditStatus, string> = {
    "load-bearing": "✓",
    stale: "✗",
    contradicts: "≠",
    "superseded-by": "→",
  };

  for (const finding of result.findings) {
    const sym = statusSymbol[finding.status] ?? "?";
    const rel = finding.related ? ` (see ${finding.related})` : "";
    deps.log(`${sym} ${finding.file}: ${finding.status}${rel}`);
    deps.log(`  ${finding.reason}`);
  }

  if (result.top_prune_candidates.length > 0) {
    deps.log("");
    deps.log("Top prune candidates:");
    for (const f of result.top_prune_candidates) {
      deps.log(`  - ${f}`);
    }
  } else {
    deps.log("");
    deps.log("No prune candidates identified.");
  }
}

// ─── Default deps ─────────────────────────────────────────────────────────────

export function defaultDeps(): MemoryDeps {
  return {
    getGitRoot: () => {
      const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (r.exitCode !== 0) return null;
      return r.stdout.toString().trim() || null;
    },
    cwd: () => process.cwd(),
    dirExists: (path) => existsSync(path),
    spawnCapture: (cmd, opts) => {
      const r = Bun.spawnSync(cmd, {
        stdout: "pipe",
        stderr: "pipe",
        stdin: opts?.input ? Buffer.from(opts.input) : undefined,
      });
      return {
        stdout: r.stdout.toString(),
        stderr: r.stderr.toString(),
        exitCode: r.exitCode ?? 1,
      };
    },
    writeTempFile: (content) => {
      const path = join(tmpdir(), `memory-audit-response-${Date.now()}.txt`);
      writeFileSync(path, content, "utf-8");
      return path;
    },
    readFile: (path) => {
      try {
        return readFileSync(path, "utf-8");
      } catch {
        return null;
      }
    },
    listFiles: (dir, ext) => {
      try {
        return readdirSync(dir)
          .filter((f) => f.endsWith(ext))
          .sort();
      } catch {
        return [];
      }
    },
    findClaudeBinary: () => {
      try {
        return resolveSourceClaudePath();
      } catch {
        return null;
      }
    },
    log: (msg) => console.log(msg),
    logError: (msg) => console.error(msg),
    exit: (code) => process.exit(code),
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export interface CmdMemoryDeps {
  exit: (code: number) => never;
  log: (msg: string) => void;
  runAudit: (opts: { json: boolean }, deps: MemoryDeps) => Promise<void>;
  makeDeps: () => MemoryDeps;
}

function defaultCmdDeps(): CmdMemoryDeps {
  return {
    exit: (code) => process.exit(code),
    log: (msg) => console.log(msg),
    runAudit: runMemoryAudit,
    makeDeps: defaultDeps,
  };
}

export async function cmdMemory(args: string[], d: CmdMemoryDeps = defaultCmdDeps()): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    d.log(HELP_TEXT);
    return;
  }

  if (sub !== "audit") {
    printError(`Unknown memory subcommand: ${sub}`);
    d.log(HELP_TEXT);
    d.exit(1);
  }

  const rest = args.slice(1);
  const json = rest.includes("--json");
  const unknownFlags = rest.filter((a) => a.startsWith("--") && a !== "--json");
  if (unknownFlags.length > 0) {
    printError(`Unknown flag(s): ${unknownFlags.join(", ")}`);
    d.exit(1);
  }

  await d.runAudit({ json }, d.makeDeps());
}

const HELP_TEXT = `mcx memory — Claude Code memory management

Usage:
  mcx memory audit [--json]    Haiku-driven staleness + contradiction check

Options:
  --json    Output machine-readable JSON (for retro-skill consumption)

Examples:
  mcx memory audit
  mcx memory audit --json`;
