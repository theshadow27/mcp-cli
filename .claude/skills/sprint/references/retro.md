# Sprint Retro

Write a retrospective diary entry capturing what happened, what worked, and
what didn't. This is internal engineering memory — concrete and specific.

## When to write

At the end of a sprint, **after** `/sprint review` (release) is done.

**IMPORTANT:** You already have the full sprint context in your conversation.
Do NOT launch transcript scanners, agents, or extraction scripts. Write the
retro directly from what you observed during the sprint.

## Determine the output file

Get the sprint number from the sprint plan:
```bash
ls .claude/sprints/sprint-*.md | sort -t- -k2 -n | tail -1
```

The diary file is: `.claude/diary/yyyyMMdd.{sprint_number}.md`

For example, sprint 12 on 2026-03-12 → `.claude/diary/20260312.12.md`

## Write the entry

Use this template exactly:

```markdown
# {yyyy-MM-dd} — {Short thematic title} (Sprint {N})

## What was done

{N} PRs merged, v{X.Y.Z} released.

**{Arc/theme name}:**
- Description of change (#issue/PR #pr) — brief technical detail
- ...

**{Another theme}:**
- ...

**Also closed:**
- Issues that were already implemented, duplicates, etc.

## What worked well

- Specific observation with evidence (e.g. "triage model was 100% accurate —
  all low scrutiny PRs passed QA first try, all high scrutiny needed repair")
- ...

## What didn't work

- Specific problem with context (e.g. "session 5c085a stuck in connecting —
  had to kill and respawn, no root cause")
- **For every failed/rolled issue**: what went wrong, why, and what specific
  improvement was made (issue refinement, planning criteria, implement
  instructions, tooling fix). Every failure must produce a concrete change.
- ...

## Patterns established

- New pattern or process change that emerged (if any)
- ...

## Stats

- **PRs merged**: N
- **Issues closed**: M (including already-done)
- **Adversarial reviews**: K (L findings fixed)
- **Failed/dropped**: J
- **Sprint cost**: ~$X (if observable)
```

## Commit and merge via PR

**Why PR, not direct-push to main**: same reason as the release flow (see
`review.md` step 4) — the autoapprover blocks direct-to-main pushes, and
docs-only retros are not a special case from its perspective. Sprint 45
hit this on the retro commit. A short-lived `sprint{N}/retro` branch →
auto-merge PR runs through the same pipeline as every other merge.

The retro PR also matches the existing in-sprint plan-amendment pattern
(e.g. `sprint45/add-1775`) — one branch namespace per sprint for all
sprint-meta commits.

```bash
# (a) Create retro branch from current main (not a worktree — short-lived)
git checkout -b sprint{N}/retro

# (b) Stage the diary file + any sprint-file Results updates
git add .claude/diary/{filename} .claude/sprints/sprint-{N}.md

# (c) Commit — SPRINT_OVERRIDE=1 still needed because the sprint-active
#     sentinel is set until the merge lands.
SPRINT_OVERRIDE=1 git commit -m "retro: sprint {N} — {short title}"

# (d) Push the branch and open an auto-merge PR
git push -u origin sprint{N}/retro
gh pr create --base main --head sprint{N}/retro \
  --title "retro: sprint {N} — {short title}" \
  --body "Sprint {N} retrospective. See \`.claude/diary/{filename}\` for the writeup and \`.claude/sprints/sprint-{N}.md\` for the planning context.

Docs-only PR — pre-commit hooks should skip the test suite."
gh pr merge --squash --delete-branch --auto

# (e) Wait for merge, then pull main
gh pr view <n> --json state,mergedAt   # poll until MERGED
git checkout main
git pull --ff-only
```

## Clear the sprint-active sentinel

```bash
rm -f .claude/sprints/.active
```

This lifts the pre-commit guard (#1443) so post-sprint maintenance commits
on main no longer need `SPRINT_OVERRIDE=1`. Do it only after the retro PR
merges — a stuck sentinel on a dead sprint still blocks commits.

## Guidelines

- Be specific: issue numbers, session IDs, file names, line counts
- Capture surprises — things that went differently than expected
- Note process improvements for the next sprint
- Keep it concise — engineering notes, not an essay
- If something went wrong, say what the fix or workaround was
