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

## Sweep memory updates authored this sprint

Before staging the diary, look for `.claude/memory/` changes that were
authored during the sprint but never committed. Memory files are routinely
written in the orchestrator's **main checkout** (where it actually runs),
not in the sprint worktree, so they sit as orphans on main unless the
retro picks them up. Sprint 42 and sprint 47 both leaked memory files this
way — `1adfcbe6 memory: sprint 42 additions` is the backfill commit.

In the orchestrator's main checkout (NOT the sprint worktree):

```bash
git status --porcelain .claude/memory/
```

Any output means there are uncommitted memory updates. Copy them into the
sprint worktree so they ride the same retro commit as the diary:

```bash
(
  cd ../../..   # → main checkout from inside .claude/worktrees/sprint-{N}
  git status --porcelain .claude/memory/
) | awk '$1 ~ /\?\?|M/ {print $2}' | while read -r f; do
  mkdir -p "$(dirname "$f")"
  cp "../../../$f" "$f"
done
```

If the orchestrator authored the memory files **directly in the worktree**,
this sweep is a no-op — `git status` in the main checkout shows nothing.

## Promote applied memories into skill text

A memory file lives in `.claude/memory/` until it earns a place in the
sprint reference docs. After 2+ sprints in a row applying the same memory,
copy the rule + **Why:** + **How to apply:** into the most-relevant
`references/*.md` (`run.md` for orchestrator-loop rules; `plan.md` for
planning rules; `review.md` / `retro.md` for those phases). Skill-text
rules apply even when memory hasn't been loaded — important for fresh
`/sprint plan` invocations that may not pull every memory file. Leave the
memory file in place; it serves user-memory injection until the skill
change merges, after which it can be archived in a future sprint.

If the memory was applied 0 times this sprint, leave it alone — it's still
earning its keep against future sessions.

These promotions are part of the sprint container PR — stage them in the
same retro commit as the diary, not a separate meta PR.

## Commit the diary on the sprint branch

The diary file is the last commit on the long-lived `sprint-{N}` branch
opened in `plan.md` Step 6a. After this, the sprint container PR has
everything (plan + amendments + run-time edits + Results + release commit
if any + diary + memory updates + skill promotions) and is ready to
merge.

Add the diary + any memory/skill updates in the sprint worktree:

```bash
(
  cd .claude/worktrees/sprint-{N}
  # Diary file path was determined above (.claude/diary/yyyyMMdd.{N}.md)
  cp ../../../{diary-file-from-main-checkout} .claude/diary/{yyyyMMdd.N}.md \
    || $EDITOR .claude/diary/{yyyyMMdd.N}.md   # or write it directly here

  # Memory + skill updates were copied in by the two preceding sections.
  # Stage everything together so the retro commit is self-contained.
  git add .claude/diary/{yyyyMMdd.N}.md .claude/memory/ .claude/skills/
  git status --short   # sanity check before committing

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

# (c) Pull main into the orchestrator's main checkout to capture the squashed sha.
#     Remove the staged plan file first — `plan.md` Step 6a kept an uncommitted
#     copy in main checkout so phase scripts could read it during run, but the
#     squash merge brings in the now-tracked version, and `git pull --ff-only`
#     aborts on the untracked-would-be-overwritten conflict. Without this,
#     `MERGED_SHA` resolves to the pre-merge HEAD and the tag lands at the
#     wrong commit (sprint 51 retro hit this — caught + retagged before any
#     consumer pulled, but only because `git rev-parse HEAD` was sanity-checked
#     against the expected squashed sha).
git checkout main
rm -f .claude/sprints/sprint-{N}.md
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

## Introspection cadence (sprints ending in 7)

If the sprint number ends in 7 (17, 27, 37, 47, **57**, 67…), queue a
code-first introspection round to feed the *next* sprint's plan. The round
runs as part of this retro: spawn one Explore agent with the prompt template
at `.claude/skills/sprint/references/introspection.md`, triage findings with
the user, and file the load-bearing ones as initiative issues. They land in
sprint-{N+1}'s plan as Bucket-1 candidates.

Skip if the sprint number does not end in 7.

The first round (sprint 47 → sprint 48) produced #1856–#1866; #1867 tracks
the cadence. See `introspection.md` for the prompt + triage flow.

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

## Anecdotes go in the diary, not in run.md

The diary is the chronological record of what happened in a sprint. The
sprint-skill `references/*.md` files are the **active rule sheet** — what
the orchestrator does on every tick, this sprint and the next. Don't
let "we burned X because of Y in sprint Z" anecdotes accrete into the
rule sheet; they belong here, in the diary. When a new rule emerges
from a sprint:

- Write the **rule + Why + How to apply** into the appropriate skill file
  (`run.md` for orchestrator-loop rules, `plan.md` for planning rules,
  etc.) — concise, no sprint number
- Capture the **incident** in the diary (this sprint's "What didn't work"
  section) with full sprint context, issue numbers, costs

If a rule's "Why" needs to cite a specific incident to be understandable,
the rule isn't general enough — keep refining until the rule stands on
its own and the diary holds the incident.

Closed-fix anecdotes (like "we used to do X until #N taught us not to")
should not live in the active rule sheet at all once the underlying fix
has shipped. Either the rule is universally true (state it without the
issue ref) or it's contingent on an open follow-up (then keep the open
issue ref so the staleness is visible).
