/**
 * Execution-context detection.
 *
 * mcp-cli runs in three meaningful audiences:
 *
 *   - ci  → GitHub Actions or generic `CI=true` runners; stream output
 *     directly to the workflow log.
 *   - ai  → A Claude Code session (orchestrator, repair, QA, etc.); preserve
 *     context by writing detailed output to a file and surfacing only a
 *     short summary.
 *   - sh  → Interactive shell; pretty-print with colour where supported.
 *
 * `--pre-commit` / `--pre-push` are intent flags, not contexts: the same
 * runner answers both, but the step list differs. Keep those separate.
 */

import type { ExecutionContext } from "./types";

export function detectContext(env: Record<string, string | undefined> = process.env): ExecutionContext {
  if (env.GITHUB_ACTIONS || env.CI) return "ci";
  if (env.CLAUDECODE || env.AGENT || env.MCP_CLI_AI) return "ai";
  const shell = env.SHELL?.split("/").pop() ?? "";
  if (["sh", "bash", "zsh"].includes(shell)) return "sh";
  return "unknown";
}

export const isPreCommit = process.argv.includes("--pre-commit");
export const isPrePush = process.argv.includes("--pre-push");
