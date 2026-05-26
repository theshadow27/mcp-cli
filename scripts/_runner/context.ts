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
 * `--pre-commit` / `--pre-push` / `--ci` are intent flags, not contexts:
 * the same runner answers all three, but the step list differs. Keep those
 * separate.
 *
 * `--pre-commit` is the fast static-only subset. `--pre-push` is the local
 * gate: static checks + diff-aware tests (`bun test --changed`), no coverage,
 * targeting a ~90s budget (#2393). `--ci` is the exhaustive gate the CI
 * workflow runs: full split suites (#1004 retry) + coverage (#1419 retry).
 * Same definition of done across hook and workflow for the CI tier (#2345).
 */

import type { ExecutionContext } from "./types";

// "0" and "false" are explicit opt-outs; anything else (including absent) is
// neither an explicit opt-in nor an explicit opt-out.
function isFalsyEnv(val: string | undefined): boolean {
  return val === "0" || val === "false";
}

export function detectContext(env: Record<string, string | undefined> = process.env): ExecutionContext {
  // AI vars take priority over CI: an agent-driven workflow (e.g. Claude
  // Action) sets both, and the file-logger context-preservation behaviour
  // is the whole reason this project tracks audience. Set MCP_CLI_AI=0 or
  // MCP_CLI_AI=false to force-opt back into the streaming path — this
  // override wins even when CLAUDECODE/AGENT are set (e.g. a non-Claude
  // agent running inside a Claude session).
  if (!isFalsyEnv(env.MCP_CLI_AI) && (env.CLAUDECODE || env.AGENT || env.MCP_CLI_AI)) return "ai";
  if (env.GITHUB_ACTIONS || env.CI) return "ci";
  const shell = env.SHELL?.split("/").pop() ?? "";
  if (["sh", "bash", "zsh"].includes(shell)) return "sh";
  return "unknown";
}

export const isPreCommit = process.argv.includes("--pre-commit");
export const isPrePush = process.argv.includes("--pre-push");
export const isCi = process.argv.includes("--ci");
