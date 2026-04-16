#!/usr/bin/env bash
# sprint_active_check: reactive safety net for #1425 / #1443.
#
# Blocks commits to the main checkout while a sprint is active. Workers
# must commit to their own worktree — any commit reaching main's cwd
# during a sprint is a containment failure by default.
#
# Skips when:
#   - Running inside a worktree (git-dir != git-common-dir)
#   - No sentinel file at .claude/sprints/.active
#   - SPRINT_OVERRIDE=1 (orchestrator release/retro/plan commits)
#
# The sentinel is created by /sprint (run phase) on start and removed
# by /sprint retro after the retro commit is pushed.
#
# Usage (from pre-commit):
#   source .git-hooks/sprint-active.sh
#   sprint_active_check || exit 1

sprint_active_check() {
  local git_dir git_common_dir
  git_dir=$(git rev-parse --git-dir 2>/dev/null) || return 0
  git_common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || return 0

  # Normalize to absolute paths — git may return relative in main, absolute in worktree.
  local abs_git_dir abs_git_common_dir
  abs_git_dir=$(cd "$git_dir" 2>/dev/null && pwd) || return 0
  abs_git_common_dir=$(cd "$git_common_dir" 2>/dev/null && pwd) || return 0

  # Worktree: git-dir points at <main>/.git/worktrees/<name>, common-dir at <main>/.git.
  if [ "$abs_git_dir" != "$abs_git_common_dir" ]; then
    return 0
  fi

  local toplevel sentinel
  toplevel=$(git rev-parse --show-toplevel 2>/dev/null) || return 0
  sentinel="$toplevel/.claude/sprints/.active"

  if [ ! -f "$sentinel" ]; then
    return 0
  fi

  if [ -n "${SPRINT_OVERRIDE:-}" ]; then
    echo "pre-commit: SPRINT_OVERRIDE=1 — allowing commit to main during active sprint" >&2
    return 0
  fi

  local sprint_num
  sprint_num=$(tr -d '[:space:]' < "$sentinel" 2>/dev/null)
  echo "pre-commit: sprint ${sprint_num:-?} is active — refusing commit to main's checkout" >&2
  echo >&2
  echo "Workers must commit to their own worktree. A commit reaching main's" >&2
  echo "cwd during a sprint is a containment failure (see #1425, #1443)." >&2
  echo >&2
  echo "Sentinel: $sentinel" >&2
  echo "Cleared by: /sprint retro (after retro commit pushes)." >&2
  echo >&2
  echo "If this is an orchestrator commit (release, retro, sprint-plan update)," >&2
  echo "bypass with:" >&2
  echo "  SPRINT_OVERRIDE=1 git commit ..." >&2
  return 1
}
