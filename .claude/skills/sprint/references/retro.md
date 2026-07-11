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

## Audit memory for staleness

Before pruning manually, run the automated audit to surface candidates:

```bash
mcx memory audit --json
```

Review the `top_prune_candidates` list. For each flagged file, verify the
reason is accurate (the audit is a suggestion, not authoritative). Prune by
deleting the file and removing its entry from `MEMORY.md`. Commit the
pruned files as part of the retro commit.

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
REPO=<ABSOLUTE path to the main checkout, e.g. /Users/you/github/mcp-cli>

# Every git call below is pinned with `git -C "$REPO"`. Never rely on the
# shell's cwd here: compound `cd X && …` commands persist the cd across
# later tool calls, and cwd drift into the sprint worktree is exactly how
# sprint 74 tagged v1.14.4 at the pre-squash branch tip (#2839).

# (a) Convert from draft to ready and arm auto-merge
gh pr ready "$SPRINT_PR"
gh pr merge "$SPRINT_PR" --squash --delete-branch --auto

# (b) Wait for merge
until [ "$(gh pr view "$SPRINT_PR" --json state -q .state)" = "MERGED" ]; do sleep 30; done

# (c) Resolve MERGED_SHA from the GitHub API — NEVER from local HEAD.
#     Local resolution has produced a wrong-sha tag twice (#2839):
#     sprint 51 (`git pull --ff-only` aborted on the untracked plan copy,
#     so HEAD was pre-merge) and sprint 74 (cwd drift → stale checkout).
#     The API's mergeCommit is authoritative and immune to both.
MERGED_SHA=$(gh pr view "$SPRINT_PR" --json mergeCommit -q .mergeCommit.oid)

#     Then sync the local main checkout. Remove the staged plan copy first —
#     `plan.md` Step 6a kept it uncommitted so phase scripts could read it
#     during run, and the squash brings in the tracked version, which makes
#     `git pull --ff-only` abort on the would-be-overwritten conflict.
git -C "$REPO" checkout main
rm -f "$REPO/.claude/sprints/sprint-{N}.md"
git -C "$REPO" fetch origin main
git -C "$REPO" pull --ff-only

# (d) Tag — only if this sprint cut a release. The release commit is INSIDE
#     the squash; the tag points at the merged sha. Three HARD GUARDS
#     (#2839) — all must pass or the tag is not created:
if [ -n "$RELEASE_VERSION" ]; then
  # Guard 1: the sha we are about to tag is actually on origin/main
  #          (fetched above). Ancestor check, not equality — another commit
  #          may legitimately land on main between merge and tag.
  git -C "$REPO" merge-base --is-ancestor "$MERGED_SHA" origin/main \
    || { echo "ABORT(#2839): $MERGED_SHA is not on origin/main — refusing to tag" >&2; exit 1; }

  # Guard 2: the commit being tagged carries the version being released.
  git -C "$REPO" show "$MERGED_SHA:package.json" | grep -q "\"version\": \"${RELEASE_VERSION#v}\"" \
    || { echo "ABORT(#2839): package.json at $MERGED_SHA is not version ${RELEASE_VERSION#v} — wrong commit or missing release commit" >&2; exit 1; }

  # Guard 3: never silently move an existing tag.
  ! git -C "$REPO" rev-parse -q --verify "refs/tags/$RELEASE_VERSION" >/dev/null \
    || { echo "ABORT(#2839): tag $RELEASE_VERSION already exists locally — investigate before retagging" >&2; exit 1; }

  git -C "$REPO" tag "$RELEASE_VERSION" "$MERGED_SHA"
  git -C "$REPO" push origin "$RELEASE_VERSION"

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

## Introspection cadence (sprints ending in 7) — MECHANICALLY GATED

If the sprint number ends in 7 (17, 27, 37, 47, ~~57~~ (skipped — see #2506), 67…), queue a
code-first introspection round to feed the *next* sprint's plan. The round
runs as part of this retro: spawn one Explore agent with the prompt template
at `.claude/skills/sprint/references/introspection.md`, triage findings with
the user, and file the load-bearing ones as initiative issues. They land in
sprint-{N+1}'s plan as Bucket-1 candidates. The round's tracking issue must
be titled like `epic: sprint-{N} introspection round — tracking` (the #2511
convention) — that title is what the mechanical guard matches.

**Load-bearing guard (#2506) — run for EVERY retro, before clearing the
sprint sentinel:**

```bash
bun scripts/check-introspection-round.ts {N}
```

Exit 1 **blocks the retro** — it means the sprint ends in 7 and no
introspection-round tracking issue exists (or GitHub was unreachable). Run
the round and file its tracking issue, then re-run the guard. Do not clear
the sentinel or convert the sprint PR to ready while this fails. For sprints
not ending in 7 the guard exits 0 immediately — running it unconditionally is
what makes the cadence skip-proof (the sprint-57 round was lost because the
check was prose-only).

The first round (sprint 47 → sprint 48) produced #1856–#1866; #1867 tracks
the cadence. See `introspection.md` for the prompt + triage flow.

## Clear the sprint-active sentinel

```bash
rm -f .claude/sprints/.active
# Verify it's gone — a stuck sentinel silently turns the main checkout
# read-only for commits until someone notices (see #2398).
test ! -e .claude/sprints/.active || { echo "FAILED to clear sentinel"; exit 1; }
```

This lifts the pre-commit guard (#1443) so post-sprint maintenance commits
on main no longer need `SPRINT_OVERRIDE=1`. Do it only after the sprint PR
merges and the worktree is removed — a stuck sentinel on a dead sprint
still blocks commits.

**Why a guaranteed terminal step**: in sprint 63 the retro ran and merged
but the sentinel survived (mtime predated the retro commit), then blocked
unrelated main-checkout commits days later. Defense-in-depth lives in
`.git-hooks/sprint-active.sh` (auto-clears when the sentinel's sprint is
already squash-merged on HEAD), but the retro must still actively clear
to avoid relying on the safety net.

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
