---
name: worktree-hookspath-inheritance
description: "mcp-cli base repo's core.hooksPath is set to an absolute path pointing at .git/hooks (samples-only) — worktrees inherit this and their pre-commit doesn't run"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2185dcf7-de50-45f7-b18b-f6da8d458a5a
---

mcp-cli's base repo `<repo-root>/.git/config` has `core.hooksPath = <repo-root>/.git/hooks` (the default samples-only directory). Worktrees created from it inherit that local config value, so their pre-commit hook never runs the checked-in `.git-hooks/pre-commit`. The `prepare` script (`bun install` → `git config core.hooksPath .git-hooks`) sets a relative path but the absolute path in the base wins.

**Why:** Caught during PR #2037 — first commit's pre-commit silently did nothing because hooksPath pointed at the samples dir. CI then failed on biome lint that should have been caught locally.

**How to apply:** When creating a new worktree on mcp-cli, immediately run `git config core.hooksPath .git-hooks` in the worktree before the first commit. Or fix the base repo's local config to use the relative path. Don't trust `bun install`'s prepare to fix it in worktrees.

See also: [[feedback_no_gpgsign_bypass]] for other pre-commit-related correctness gotchas.
