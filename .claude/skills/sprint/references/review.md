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

- **Major** (X.0.0): Breaking changes to CLI interface, IPC protocol, config format
- **Minor** (0.X.0): New features, commands, flags, config options
- **Patch** (0.0.X): Bug fixes, performance, internal refactors, tests, docs

Think about what the *user* experiences, not commit prefixes.

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

```bash
# Update version
bun -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json','utf-8'));
  pkg.version = 'X.Y.Z';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Commit, tag, push
git add package.json
git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git push origin main vX.Y.Z

# Create GitHub release
gh release create vX.Y.Z --title "vX.Y.Z" --notes "$(cat <<'EOF'
<release notes>
EOF
)"
```

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
