---
name: release
description: >
  Create a versioned release from the current state of main. Reads the latest
  diary entry or sprint summary, generates release notes, determines the semver
  bump, tags, and pushes. Use when the user says "cut a release", "ship it",
  "/release", "tag a version", or at natural sprint boundaries.
---

# Release

Create a tagged release with human-readable release notes.

## When to release

- At the end of a sprint (natural batch of work)
- When the user asks
- When a meaningful set of changes has landed and it feels like a good boundary

There is no automation — releases are intentional. You decide the version.

## Step 1: Gather context

Figure out what's changed since the last release:

```bash
git describe --tags --abbrev=0   # last tag
git log <last-tag>..HEAD --oneline
```

Also check for a recent diary entry in `.claude/diary/` — the "What was done"
section is a good starting point for release notes.

## Step 2: Determine the version bump

Follow [Semantic Versioning](https://semver.org/):

- **Major** (X.0.0): Breaking changes to the CLI interface, IPC protocol,
  config format, or any other contract that external consumers depend on.
  Removing commands, changing output formats, dropping support for config keys.
- **Minor** (0.X.0): New features, new commands, new flags, new config options.
  Anything additive that doesn't break existing usage.
- **Patch** (0.0.X): Bug fixes, performance improvements, internal refactors,
  test improvements, documentation, CI changes. Anything that doesn't change
  the user-facing surface.

Use your judgment. The commit prefixes (`feat:`, `fix:`, etc.) are hints but
not gospel — a `feat:` that adds an internal-only helper isn't really a minor
bump. A `fix:` that changes output format might be a major bump. Think about
what the *user* experiences.

While pre-1.0 (0.x.y), breaking changes can go in minor bumps per semver spec,
but prefer to still be deliberate about it.

## Step 3: Write release notes

Format:

```markdown
## What's New

- **Feature name** — one-line description (#PR)
- **Another feature** — one-line description (#PR)

## Fixes

- Fix description (#PR)
- Another fix (#PR)

## Internal

- Refactoring, test improvements, CI changes (#PR)
```

Group by user impact, not by file or package. Skip internal-only changes that
no user would care about (test refactors, CI tweaks) or collapse them into a
single "Internal improvements" line.

## Step 4: Tag and push

```bash
# Update package.json with the new version
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
```

The tag push triggers the Release workflow (`.github/workflows/release.yml`)
which builds cross-platform binaries and creates the GitHub Release.

## Step 5: Create the GitHub Release

After pushing the tag, create the release with the notes:

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "$(cat <<'EOF'
<release notes from step 3>
EOF
)"
```

If the Release workflow hasn't finished building yet, create the release
without assets — the workflow will attach them when it completes.

## Rules

- Never tag without reading what changed. Blind version bumps are bad releases.
- Never force-push tags. If you tagged wrong, create a new version.
- The release workflow handles binary builds — don't build locally for releases.
- Keep release notes concise. Users scan, they don't read essays.
