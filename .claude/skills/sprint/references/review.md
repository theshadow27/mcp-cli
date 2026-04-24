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

## Step 4: Execute the release via PR

**Why PR, not direct-push to main**: the autoapprover blocks direct-to-main
pushes by default (hit during sprint 44 wind-down). Releases are the one
legitimate direct-main case, but the autoapprover doesn't distinguish —
each release would require out-of-band user authorization. A short-lived
`release/vX.Y.Z` branch → auto-merge PR runs through the same pipeline as
every other merge, satisfies the autoapprover, and keeps the tag + release
creation flow unchanged. Cost: ~2 min of CI on the release PR.

The broader restructuring of mid-sprint meta commits (sprint plan, retro,
meta-fixes) is tracked in **#1773** and is out of scope for this file.

**These steps are NOT atomic.** The pre-commit hook can fail the commit
while later steps (tag, push) appear to succeed. Run them strictly in
order, verifying each step before the next.

```bash
# (a) Create release branch from current main (not a worktree — short-lived)
git checkout -b release/vX.Y.Z

# (b) Bump version
bun -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json','utf-8'));
  pkg.version = 'X.Y.Z';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# (c) Format + check BEFORE commit — pre-commit hook will reject otherwise
bun lint          # applies biome fixes (e.g. package.json array collapse)
bun typecheck     # catches TS errors before the hook does

# (d) Commit — SPRINT_OVERRIDE=1 bypasses the sprint-active pre-commit guard
# (#1443) if the sentinel is still set this early in wind-down.
git add package.json
SPRINT_OVERRIDE=1 git commit -m "release: vX.Y.Z"
RELEASE_SHA=$(git rev-parse HEAD)
git log -1 --oneline "$RELEASE_SHA"   # verify it's the release commit

# (e) Push the branch and open an auto-merge PR
git push -u origin release/vX.Y.Z
gh pr create --base main --head release/vX.Y.Z \
  --title "release: vX.Y.Z" \
  --body "$(cat <<'EOF'
Release v X.Y.Z. Release notes will be posted on the GitHub release after
the tag lands.

See the sprint file (`.claude/sprints/sprint-{N}.md`) for what shipped.
EOF
)"
gh pr merge --squash --delete-branch --auto

# (f) Wait for the PR to merge, then pull main and capture the MERGED sha
mcx claude wait --timeout 270000   # or poll: gh pr view <n> --json state,mergedAt
git checkout main
git pull --ff-only
MERGED_SHA=$(git rev-parse HEAD)
git log -1 --oneline "$MERGED_SHA" | grep -q "release: vX.Y.Z" \
  || { echo "ERROR: main HEAD is not the release commit — abort" >&2; exit 1; }

# (g) Only now tag — at the MERGED sha (squash rewrote history, so $RELEASE_SHA
# from step (d) is stale and must NOT be used for the tag)
git tag vX.Y.Z "$MERGED_SHA"
git push origin vX.Y.Z

# (h) GitHub release — tag push may auto-trigger a Release workflow;
#     wait for it to finish before creating the release, or use --draft
gh release create vX.Y.Z --title "vX.Y.Z" --notes "$(cat <<'EOF'
<release notes>
EOF
)"
```

### If the commit fails (pre-commit hook rejected it)

1. Read the hook output — usually a lint/typecheck fix.
2. Apply the fix, re-stage, re-commit on the same `release/vX.Y.Z` branch.
3. Force-push the branch if needed (`git push -f`) — the PR updates in place.
4. **Do not tag until the PR merges.** If you already pushed a tag pointing
   at the wrong sha, delete it local + remote (`git tag -d vX.Y.Z && git push
   origin :vX.Y.Z`), cancel any triggered Release workflow, delete the draft
   GitHub release, and restart from step (g). Memory rule: never force-push
   a tag — delete + recreate when it's fresh (minutes old, no consumers), or
   bump to the next patch version if it's been out long enough that someone
   might have pulled.

### If the PR won't auto-merge

`--auto` requires green CI + no conflicts. If `check` / `coverage` / `build`
flake or fail on the release PR:

1. Investigate. If it's a flake, re-run from the GitHub UI or `gh run rerun <id>`.
2. If it's a real break on main, fix main first (separate PR), rebase the
   release branch, force-push, re-arm `--auto`.
3. Never disable branch protection to force the release through. The whole
   point of the PR flow is to keep the release in the same gate as every
   other merge.

## Step 5: Update the sprint file

Append a results section to `.claude/sprints/sprint-{N}.md`:

```markdown
## Results

- **Released**: vX.Y.Z
- **PRs merged**: N
- **Issues closed**: M
- **Issues dropped**: K (with reasons)
- **New issues filed**: J (from reviews/QA)
```

## Rules

- Never tag without reading what changed
- Never force-push tags — create a new version if wrong
- Keep release notes concise — users scan, not read
