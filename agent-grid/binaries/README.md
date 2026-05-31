# agent-grid/binaries

Archived agent provider binaries, content-addressed and stored in **Git LFS**
(see `.gitattributes` — only `*.tgz` is LFS-tracked; `*.sha256` sidecars stay
regular blobs so they read without an LFS smudge).

These are an offline fallback for `scripts/install-agent.ts` (#2583) when a
registry no longer serves a pinned version. **Archives are added explicitly,
one PR at a time — there is no automatic promotion.**

## Inventory

| Artifact | Provider | Version | Platform | tgz sha256 |
|----------|----------|---------|----------|------------|
| `claude-2.1.119.tgz` | claude | 2.1.119 | **darwin-arm64** | `5035cb068148a66444a8b8642b3d5eab926c086961101840dbe1baa62957bbc0` |

### claude-2.1.119.tgz

- **Why archived:** 2.1.119 is auto-sprint's pinned `claudeBinary` (the last
  release before the 2.1.121 `--sdk-url` lockdown — see
  `.claude/memory/feedback_claude_2_1_121_break.md`). It is the only known-good
  copy left; npm may yank it. This archive removes the single-point-of-failure.
- **Provenance:** the user's locally-pinned binary at
  `~/.local/share/mcp-cli-archive/claude-code/claude-2.1.119`.
- **Contents:** a single Bun-compiled Mach-O **arm64** executable named
  `claude-2.1.119` (204 MB uncompressed → 62 MB gzipped).
- **Checksums:**
  - tgz: `5035cb068148a66444a8b8642b3d5eab926c086961101840dbe1baa62957bbc0`
    (also the LFS oid — verifiable straight from the pointer; mirrored in
    `claude-2.1.119.tgz.sha256`)
  - inner binary: `31db3444309d5d0f8b85e8782e2dcd86f31f7e48c1a1e83d69b09268c7b4f9a2`
    (verify after extraction)

## Platform-specific archives

Archives are platform-specific. Each `versions.yaml` entry with an `archive`
field should also have a `platform` field (`darwin-arm64`, `darwin-x64`,
`linux-x64`, or `linux-arm64`). `install-agent.ts` auto-detects the host
platform and selects the matching entry. Entries without a `platform` field are
treated as platform-agnostic (e.g. Node.js scripts that run anywhere).

When adding a binary for an additional platform, use the naming convention
`<provider>-<version>-<platform>.tgz` (e.g. `claude-2.1.119-linux-x64.tgz`).

## Adding a new archive

1. `tar -C <dir-containing-binary> -czf agent-grid/binaries/<name>.tgz <binary>`
   (deterministic flags: `--uid 0 --gid 0 --numeric-owner`, `gzip -9 -n`
   so checksums are reproducible across machines).
2. `shasum -a 256 agent-grid/binaries/<name>.tgz > agent-grid/binaries/<name>.tgz.sha256`
3. Add the row to `versions.yaml` with `archive`, `platform`, and optionally
   `binary_sha256`.
4. Commit — `.gitattributes` routes the `.tgz` to LFS automatically.

**LFS push note:** This repo uses `core.hooksPath=.git-hooks`, which means
git-lfs's own `pre-push` hook is inactive. After committing LFS-tracked files,
push objects explicitly with `git lfs push origin <branch>` before `git push`.
