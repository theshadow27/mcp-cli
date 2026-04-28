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

**Where to write it**: directly inside the sprint worktree at
`.claude/worktrees/sprint-{N}/.claude/diary/{filename}` — that's where it
gets committed. (You can also write it in main checkout's working tree
first if it's easier to draft there, then `cp` into the worktree before
the commit step below. The sprint-active sentinel will block any commit
from main checkout, which is what we want.)

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

## Commit the diary on the sprint branch

The diary file is the last commit on the long-lived `sprint-{N}` branch
opened in `plan.md` Step 6a. After this, the sprint container PR has
everything (plan + amendments + run-time edits + Results + release commit
if any + diary) and is ready to merge.

Add the diary in the sprint worktree:

```bash
(
  cd .claude/worktrees/sprint-{N}
  # Diary file path was determined above (.claude/diary/yyyyMMdd.{N}.md)
  cp ../../../{diary-file-from-main-checkout} .claude/diary/{yyyyMMdd.N}.md \
    || $EDITOR .claude/diary/{yyyyMMdd.N}.md   # or write it directly here
  git add .claude/diary/{yyyyMMdd.N}.md
  SPRINT_OVERRIDE=1 git commit -m "retro: sprint {N} — {short title}"
  git push
)
```

## Merge the sprint PR + tag the release

The sprint container PR is still **draft** (set in `plan.md` Step 6a).
Convert it to ready, arm auto-merge, wait for it to land. After it merges,
tag the release at the merged sha (if a release commit was added in
`review.md` step 4) and create the GitHub release.

```bash
SPRINT_PR=<the sprint-{N} PR number>

# (a) Convert from draft to ready and arm auto-merge
gh pr ready "$SPRINT_PR"
gh pr merge "$SPRINT_PR" --squash --delete-branch --auto

# (b) Wait for merge
until [ "$(gh pr view "$SPRINT_PR" --json state -q .state)" = "MERGED" ]; do sleep 30; done

# (c) Pull main into the orchestrator's main checkout to capture the squashed sha
git checkout main
git pull --ff-only
MERGED_SHA=$(git rev-parse HEAD)

# (d) Tag — only if this sprint cut a release. Verify the merged commit is
#     the squashed sprint commit (it'll be a single squash commit, not
#     "release: vX.Y.Z" anymore — the title is whatever GitHub squashed it
#     to, typically the PR title). The release commit is INSIDE the squash;
#     the tag points at the merged sha regardless.
if [ -n "$RELEASE_VERSION" ]; then
  git tag "$RELEASE_VERSION" "$MERGED_SHA"
  git push origin "$RELEASE_VERSION"

  gh release create "$RELEASE_VERSION" --title "$RELEASE_VERSION" --notes "$(cat <<'EOF'
<release notes prepared in review.md Step 3>
EOF
)"
fi
```

## Clean up the sprint worktree

After the PR merges, remove the sprint worktree and prune the local branch.

```bash
git worktree remove .claude/worktrees/sprint-{N}
git branch -D sprint-{N}   # local branch (remote was --delete-branch'd by gh pr merge)
```

## Clear the sprint-active sentinel

```bash
rm -f .claude/sprints/.active
```

This lifts the pre-commit guard (#1443) so post-sprint maintenance commits
on main no longer need `SPRINT_OVERRIDE=1`. Do it only after the sprint PR
merges and the worktree is removed — a stuck sentinel on a dead sprint
still blocks commits.

## Guidelines

- Be specific: issue numbers, session IDs, file names, line counts
- Capture surprises — things that went differently than expected
- Note process improvements for the next sprint
- Keep it concise — engineering notes, not an essay
- If something went wrong, say what the fix or workaround was
