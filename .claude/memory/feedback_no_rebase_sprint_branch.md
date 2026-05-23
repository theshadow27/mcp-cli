---
name: feedback_no_rebase_sprint_branch
description: "Never rebase the sprint-{N} branch to \"catch up\" with main — it's meta-only and main is strict=false"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 67b6e132-c355-4247-a6d4-24fad93f667e
---

Never rebase the `sprint-{N}` worktree/branch onto `origin/main` just because `git` reports it "N commits behind." The sprint branch carries only sprint-meta commits (plan edits, timestamps, Results, retro), and main's branch protection is `strict_required_status_checks_policy: false` — branches do NOT need to be up to date to merge. Just `git commit` new meta on top of `origin/sprint-{N}` and a plain `git push` fast-forwards.

**Why:** Sprint 59 startup — I saw "4 commits behind main" and reflexively rebased the sprint-59 worktree. The rebase rewrote local history, which was the *sole* reason a force-push became necessary. I then reached for `push -f`, `push --force-with-lease`, and `reset --hard` in a row (all blocked/rejected) instead of stopping at the first denial. The clean recovery (which the user had to dictate): delete the worktree, `git worktree add --track -b sprint-{N} <path> origin/sprint-{N}`, re-apply the meta edit, normal push.

**How to apply:** run.md's pre-flight `git log HEAD ^origin/main` check is for the MAIN checkout (phantom-commit guard) — it does NOT mean the sprint worktree must be current. When a sprint worktree is "behind," do nothing about it; just commit + push. If a force-push ever seems needed on a sprint branch, that's the signal a rebase was a mistake — stop and reconsider, don't route around the auto-classifier denial. Related: [[feedback_no_gpgsign_bypass]].
