#!/usr/bin/env bash
# classify_files: classify a newline-delimited list of filenames into tiers.
#
# Reads filenames from stdin, sets two variables in the caller's scope:
#   has_source  (true/false)
#   has_config  (true/false)
#
# If neither is true, all files were docs-only (or input was empty).
#
# Usage:
#   classify_files <<< "$staged_files"

classify_files() {
  has_source=false
  has_config=false

  local file
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    case "$file" in
      # Docs: markdown files plus the enumerated docs-only .claude/ subdirs.
      # Other .claude/ paths are NOT docs — .claude/phases/*.ts are executable
      # phase scripts with specs run by am-i-done (test:phases, #2648), and
      # automation/workflows/skills also carry runnable code (#2717). They
      # fall through to config (*.json) or source below.
      # Keep in sync with the detect job in .github/workflows/ci.yml.
      *.md | .claude/diary/* | .claude/sprints/* | .claude/memory/*)
        ;;
      # Config: JSON files, scripts/, build tooling, git hooks, CI workflows
      *.json | scripts/* | .git-hooks/* | .github/*)
        has_config=true
        ;;
      # Everything else is source code
      *)
        has_source=true
        ;;
    esac
  done
}
