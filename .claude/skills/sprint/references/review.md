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

## Step 4: Execute the release

**These steps are NOT atomic.** The pre-commit hook can fail the commit
while later steps (tag, push) appear to succeed. Run them strictly in
order, verifying each step before the next.

```bash
# (a) Bump version
bun -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json','utf-8'));
  pkg.version = 'X.Y.Z';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# (b) Format + check BEFORE commit — pre-commit hook will reject otherwise
bun lint          # applies biome fixes (e.g. package.json array collapse)
bun typecheck     # catches TS errors before the hook does

# (c) Commit — capture the sha so we only tag if this actually succeeded
git add package.json
git commit -m "release: vX.Y.Z"
RELEASE_SHA=$(git rev-parse HEAD)
git log -1 --oneline "$RELEASE_SHA"   # verify it's the release commit

# (d) Push commit first (no tag yet)
git push origin main

# (e) Only now tag — and only at the verified release sha
git tag vX.Y.Z "$RELEASE_SHA"
git push origin vX.Y.Z

# (f) GitHub release — tag push may auto-trigger a Release workflow;
#     wait for it to finish before creating the release, or use --draft
gh release create vX.Y.Z --title "vX.Y.Z" --notes "$(cat <<'EOF'
<release notes>
EOF
)"
```

### If the commit fails (pre-commit hook rejected it)

1. Read the hook output — usually a lint/typecheck fix.
2. Apply the fix, re-stage, re-commit.
3. **Do not push a tag until step (c) succeeds.** If you already pushed a
   tag pointing at the wrong sha, delete it local + remote
   (`git tag -d vX.Y.Z && git push origin :vX.Y.Z`), cancel any
   triggered Release workflow, delete the draft GitHub release, and
   restart at step (c). Memory rule: never force-push a tag — delete +
   recreate when it's fresh (minutes old, no consumers), or bump to the
   next patch version if it's been out long enough that someone might
   have pulled.

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
