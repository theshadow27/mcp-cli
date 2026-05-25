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
 * `--pre-push` and `--ci` resolve to the same CI step list (split tests
 * with #1004 retry, coverage with #1419 retry, `lint:check` — no
 * `--write`). The pre-push hook and the CI workflow share one definition
 * of done (#2345). `--pre-commit` is the fast static-only subset.
 */

import type { ExecutionContext } from "./types";

export function detectContext(env: Record<string, string | undefined> = process.env): ExecutionContext {
  // AI vars take priority over CI: an agent-driven workflow (e.g. Claude
  // Action) sets both, and the file-logger context-preservation behaviour
  // is the whole reason this project tracks audience. Set MCP_CLI_AI=0
  // (or leave AI vars unset) to opt back into the CI streaming path.
  if (env.CLAUDECODE || env.AGENT || env.MCP_CLI_AI) return "ai";
  if (env.GITHUB_ACTIONS || env.CI) return "ci";
  const shell = env.SHELL?.split("/").pop() ?? "";
  if (["sh", "bash", "zsh"].includes(shell)) return "sh";
  return "unknown";
}

export const isPreCommit = process.argv.includes("--pre-commit");
export const isPrePush = process.argv.includes("--pre-push");
export const isCi = process.argv.includes("--ci");
