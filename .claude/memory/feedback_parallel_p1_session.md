---
name: Don't touch the user's parallel #1808 worktrees
description: User runs the binary-patcher P1 (#1808) in a separate direct-claude session. Don't blanket-prune worktrees during sprint cleanup.
type: feedback
originSessionId: 8be6c24d-3c8c-419f-9862-e43e3b61a449
---
**Rule:** During sprint cleanup, NEVER run `mcx gc` or `mcx claude worktrees --prune` blindly, and NEVER `bye` a session you didn't spawn. The user runs the #1808 binary-patcher P1 work in a separate **direct claude session** (not via mcx daemon) — it doesn't appear in `mcx claude ls`, but its worktree IS in `.claude/worktrees/`.

**Why:** Sprint 46 (2026-04-27): user explicitly said "I'm running 1808 manually in a different window please don't clobber it … if you see the worktree don't delete it please." Their #1808 work shipped in pieces as PR #1826, #1830, etc. via the autosprint pulling them in as opus-QA picks; the parent session that authored them stays alive across sprints.

**How to apply:**

1. **Worktrees named `issue-1808*`, `feat/issue-1808-*`, or anything that smells like patcher / TLS / sdk-url work** — leave them alone unless the user tells you otherwise.
2. **At sprint wind-down**, when `run.md` says "`mcx gc` to prune merged branches and stale worktrees" — DON'T. Targeted cleanup only: `git worktree remove .claude/worktrees/sprint-{N}` plus `git branch -D sprint-{N}`. Anything else, ask first.
3. **At spawn time**, mcx auto-creates worktrees with names like `claude-mo<random>` — those ARE yours, you can bye+remove them.
4. **The daemon restart in pre-flight is safe** for the user's parallel session because their claude session is direct (not connected to mcpd's WebSocket). Restarting the daemon doesn't kill them.
5. **If the user pastes a PR number and asks you to QA it**, that's the ingestion pattern: `mcx track <issue> + force phase=qa + spawn opus QA`. Don't try to refactor or modify the PR — just QA it like any other.
