/**
 * Rule: spec-git-env-spread
 *
 * Test files must not spread `process.env` directly into a subprocess `env`
 * option without stripping the git hook variables. When `bun test` runs inside
 * a git pre-push or pre-commit hook, `GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, and `GIT_OBJECT_DIRECTORY` are already
 * set in the environment. A naked `{ env: { ...process.env, ... } }` spreads
 * them in — git then ignores any `-C <tempDir>` flag and operates on the
 * **real worktree** instead of the test directory.
 *
 * Canonical fix: use `cleanGitEnv()` (see packages/core/src/git.spec.ts:227)
 * which destructures away the hook vars before spreading.
 *
 * If the subprocess is provably non-git and cannot call git internally,
 * suppress with: // dotw-ignore spec-git-env-spread: <reason>
 *
 * Safe form also accepted inline: explicit `GIT_DIR: undefined` next to the
 * spread on the same line exempts the match.
 *
 * Prior incidents: #2400, #2527, #1347, #1339, #1282 (same root cause).
 * Regression in PR #2689 (session-deps.spec.ts, commit 2bf501b5).
 */

import type { PatternRule } from "./_engine/rule";

const rule: PatternRule = {
  id: "spec-git-env-spread",
  kind: "pattern",
  appliesToTests: true,
  scold:
    "spreading process.env into a test subprocess env inherits GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE from the parent hook — git ignores -C and operates on the real worktree",
  pattern: /env:\s*\{\s*\.\.\.\s*process\.env/,
  except: ["GIT_DIR: undefined"],
  guidance: [
    "use cleanGitEnv() (packages/core/src/git.spec.ts:227) to strip the hook vars before spreading",
    "or construct a bare env object without ...process.env spread for subprocess isolation",
    "if the subprocess is provably non-git (e.g. a TLS test, mcx import), add: // dotw-ignore spec-git-env-spread: <reason>",
  ],
  documentation: "#2696",
};

export default rule;
