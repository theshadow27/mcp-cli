# Documentation Review

Review project documentation for consistency with recent code changes. Docs are part of the product — if a feature was added but not documented, or an old pattern was removed but still referenced, that's a bug.

## Input

One or more PR numbers (merged or open) to review against. Parse from: $ARGUMENTS

Example: `/documentation-review 123 124 125 126`

## Workflow

### 1. Gather Context

For each PR number, fetch the diff and summary:

```bash
gh pr view <number> --json title,body,files
```

Build a list of what changed: new commands, renamed files, changed APIs, removed features, updated patterns.

### 2. Review Each Document

Check every document below against the changes. For each, ask: "Does this document accurately describe the project as it exists right now?"

#### Documents to review

| Document | Why it matters |
|----------|---------------|
| `CLAUDE.md` | The primary instruction set for every Claude session. Outdated paths, missing commands, or stale patterns here cause repeated mistakes across all sessions. |
| `README.md` | First thing a new session (or human) reads. Installation, usage examples, and feature lists must reflect reality. |
| `test/CLAUDE.md` | Test conventions guide. If new test patterns were established or old ones deprecated, this needs updating so future test writers follow current practice. |
| `.claude/commands/*.md` | Slash commands reference specific file paths, CLI flags, and workflows. A renamed file or new flag can silently break a command's instructions. |
| `.claude/skills/*/SKILL.md` | Skills orchestrate multi-step workflows. Changed tool names, new pipeline steps, or updated conventions need to flow through here. |
| CLI help text (in `packages/command/src/commands/`) | The `--help` output users actually see. New flags, changed defaults, or removed options must be reflected in the help strings. |

#### What good looks like

- File paths in docs point to files that actually exist
- Command examples use current flag names and syntax
- Architecture descriptions match the actual package structure
- Feature lists include recently added capabilities
- Removed or renamed items are cleaned up, not left as stale references
- Code examples compile and run correctly

### 3. Fix Issues

For each inconsistency found:

1. Fix it directly if straightforward (wrong path, missing command in a list, stale example)
2. For larger gaps (missing documentation for a whole feature), write the new content following the style of surrounding docs

Keep fixes focused — match the existing voice and format of each document rather than rewriting sections unnecessarily.

### 4. Verify and Commit

```bash
bun typecheck
bun lint
bun test
```

Stage and commit documentation fixes:

```bash
git add <files>
git commit -m "docs: update documentation for recent changes (PRs #...)"
```

### 5. Create PR

```bash
git push -u origin <branch>
gh pr create --title "docs: update documentation for recent changes" --body "$(cat <<'EOF'
## Summary
- Reviewed documentation against recent PRs: #...
- Fixed inconsistencies in: <list of files updated>

## Documents reviewed
- [ ] CLAUDE.md
- [ ] README.md
- [ ] test/CLAUDE.md
- [ ] .claude/commands/*.md
- [ ] .claude/skills/*/SKILL.md
- [ ] CLI help text

Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### 6. File Issues for Larger Problems

If you discover problems that are beyond documentation scope (broken features, missing tests, architectural concerns), file them as separate issues rather than trying to fix everything in a docs PR.
