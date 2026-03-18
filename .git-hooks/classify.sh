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
      # Docs: markdown files, .claude/ directory contents
      *.md | .claude/*)
        ;;
      # Config: JSON files, scripts/, build tooling, git hooks
      *.json | scripts/* | .git-hooks/*)
        has_config=true
        ;;
      # Everything else is source code
      *)
        has_source=true
        ;;
    esac
  done
}
