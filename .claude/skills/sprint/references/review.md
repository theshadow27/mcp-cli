# Sprint Review

Cut a release and write a changelog. This is the user-facing output of the sprint.

## Step 1: Gather what shipped

```bash
git describe --tags --abbrev=0   # last tag
git log <last-tag>..HEAD --oneline
```

Also read the sprint plan (`.claude/sprints/sprint-{N}.md`) to compare planned
vs actual — note what was dropped or added.

## Step 2: Determine the version bump

Follow [Semantic Versioning](https://semver.org/):

- **Major** (X.0.0): Backwards-incompatible change to a top-level command (renamed, removed, changed semantics)
- **Minor** (0.X.0): New top-level command or new package
- **Patch** (0.0.X): Everything else — new flags, features, bug fixes, refactors, tests, docs

Most releases will be patches. Minor is rare (new `mcx <command>`). Major is exceptional.

## Step 3: Write release notes

```markdown
## What's New

- **Feature name** — one-line description (#PR)

## Fixes

- Fix description (#PR)

## Internal

- Refactoring, test improvements (#PR)
```

Group by user impact. Collapse internal-only changes into a single line.

## Step 4: Add the release commit to the sprint branch

The release commit (`package.json` version bump) goes on the long-lived
`sprint-{N}` branch via the sprint worktree opened in `plan.md` Step 6a —
**no separate `release/vX.Y.Z` branch**. The sprint container PR squash-
merges all sprint-meta commits (plan, amendments, Results, retro, release)
together at retro time. Tag at the merged sha after the sprint PR lands.

This step doesn't merge anything yet — it only adds the release commit to
the sprint branch. The actual merge (and tag) happens at retro time, after
the diary lands, in `retro.md` Step "Merge the sprint PR + tag the release".

**These steps are NOT atomic.** The pre-commit hook can fail the commit
while later steps appear to succeed. Run them strictly in order, verifying
each step before the next.

```bash
# (a) Pull latest main into the sprint worktree, rebase the sprint branch
#     onto it. Workers have been merging to main throughout the sprint —
#     rebase picks those up so package.json is bumped on top of the
#     latest version.
(
  cd .claude/worktrees/sprint-{N}
  git fetch origin main
  git rebase origin/main
  # If rebase produces conflicts on .claude/sprints/sprint-{N}.md or the
  # diary file, that's a meta-file conflict — workers shouldn't be touching
  # those (per plan.md Step 3 rule 5). Investigate before proceeding.
)

# (b) Bump version inside the sprint worktree
bun -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('.claude/worktrees/sprint-{N}/package.json','utf-8'));
  pkg.version = 'X.Y.Z';
  fs.writeFileSync('.claude/worktrees/sprint-{N}/package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# (c) Format + check BEFORE commit — pre-commit hook will reject otherwise.
#     Run from the sprint worktree so biome sees the right working tree.
(
  cd .claude/worktrees/sprint-{N}
  bun lint          # applies biome fixes (e.g. package.json array collapse)
  bun typecheck     # catches TS errors before the hook does
)

# (d) Commit + force-push the sprint branch — SPRINT_OVERRIDE=1 bypasses
#     the sprint-active pre-commit guard (#1443). Force-push (with-lease)
#     is needed because the rebase rewrote history.
(
  cd .claude/worktrees/sprint-{N}
  git add package.json
  SPRINT_OVERRIDE=1 git commit -m "release: vX.Y.Z"
  git push --force-with-lease
)

# (e) Verify the sprint PR picked up the release commit
gh pr view <sprint-pr> --json commits -q '.commits[-1].messageHeadline'
# Expected: "release: vX.Y.Z"
```

The sprint PR is still draft. The actual merge + tag happens at retro time.

If the release skill needs an alternate flow (e.g. cutting a hotfix off
main mid-sprint, or releasing without a sprint), use the older
`release/vX.Y.Z` short-lived branch flow — but the in-sprint release is
always part of the sprint container.

### If the commit fails (pre-commit hook rejected it)

1. Read the hook output — usually a lint/typecheck fix.
2. Apply the fix in the sprint worktree, re-stage, re-commit.
3. Force-push the sprint branch (`git push --force-with-lease`) — the
   sprint container PR updates in place.
4. **Do not tag yet.** Tagging happens in `retro.md` *after* the sprint PR
   merges. If a Release workflow gets triggered by an early tag push,
   cancel it, delete the tag (local + remote), and restart from there.
   Memory rule: never force-push a tag — delete + recreate when it's
   fresh (minutes old, no consumers), or bump to the next patch version
   if it's been out long enough that someone might have pulled.

## Step 5: Add the Results section to the sprint file

Append the Results section to `.claude/sprints/sprint-{N}.md` **inside the
sprint worktree** (not in main checkout — see `run.md` "Sprint-meta edits
during run"), commit it on the same `sprint-{N}` branch, push.

```markdown
## Results

- **Released**: vX.Y.Z (or "no release this sprint" if release was skipped)
- **PRs merged**: N
- **Issues closed**: M
- **Issues dropped**: K (with reasons)
- **New issues filed**: J (from reviews/QA)
```

```bash
(
  cd .claude/worktrees/sprint-{N}
  $EDITOR .claude/sprints/sprint-{N}.md   # append the Results section
  git add .claude/sprints/sprint-{N}.md
  SPRINT_OVERRIDE=1 git commit -m "sprint({N}): results"
  git push
)
# Sync back to main checkout so retro can read the latest plan content
cp .claude/worktrees/sprint-{N}/.claude/sprints/sprint-{N}.md .claude/sprints/sprint-{N}.md
```

The release commit and Results section are now both on the sprint branch.
Continue inline to `retro.md`, which writes the diary, finalizes the
sprint PR (draft → ready, auto-merge), and tags the release post-merge.

## Rules

- Never tag without reading what changed
- Never force-push tags — create a new version if wrong
- Keep release notes concise — users scan, not read
- The release commit and the tag are bound to the **sprint container PR**
  — tag at the merged sha, never at a pre-merge commit
