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

## Platform note (read before consuming)

This archive is **darwin-arm64 only**. `install-agent --offline claude@2.1.119`
will produce a binary that runs only on Apple-silicon macOS. The grid currently
runs on that platform, so this is sufficient today. When the matrix grows to
other platforms, `versions.yaml` (#2578) needs a `platform` field and this dir
needs per-platform archives (`claude-2.1.119-darwin-arm64.tgz`, …). Filed as a
follow-up — do not assume cross-platform.

## Adding a new archive

1. `tar -C <dir-containing-binary> -czf agent-grid/binaries/<name>.tgz <binary>`
   (deterministic flags: `--uid 0 --gid 0 --numeric-owner`, `gzip -9 -n`).
2. `shasum -a 256 agent-grid/binaries/<name>.tgz > agent-grid/binaries/<name>.tgz.sha256`
3. Add the row to `versions.yaml` (#2578) with `archivePath` + checksum.
4. Commit — `.gitattributes` routes the `.tgz` to LFS automatically.
