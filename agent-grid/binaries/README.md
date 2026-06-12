# agent-grid/binaries

Archived agent provider binaries, content-addressed in **Git LFS** storage. The
`*.tgz` blobs are **not** checked into HEAD and are **not** pulled on checkout —
only the `*.sha256` sidecars live in the tree. This is deliberate: a 59 MB blob
dragged on every CI checkout was burning ~13 GB/mo of LFS bandwidth and 403ing
unrelated CI (#2741). The blobs are kept retrievable in LFS storage, referenced
by the tag `archive/agent-grid-claude-2.1.119`.

These are an offline fallback for `scripts/install-agent.ts` (#2583) when a
registry no longer serves a pinned version. **Archives are added explicitly,
one PR at a time — there is no automatic promotion.**

## Retrieving a blob

The `.tgz` is not in your working tree after a clone. Fetch it on demand
straight from the LFS batch API (no `git lfs pull`, no LFS-on-checkout):

```bash
GITHUB_TOKEN=$(gh auth token) scripts/fetch-lfs-blob.sh
```

The script verifies the SHA-256 against the OID and is a no-op if the blob is
already present and intact.

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
    (also the LFS oid — mirrored in `claude-2.1.119.tgz.sha256` and used as the
    fetch key in `scripts/fetch-lfs-blob.sh`)
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
4. Upload the blob to LFS storage and keep it referenced so checkout never pulls
   it: push it under a dedicated `lfs:` rule on a throwaway branch (or
   `git lfs push origin <oid>`), tag the referencing commit
   `archive/<name>`, then remove the `.tgz` pointer + the temporary LFS rule
   from HEAD before merging. Commit only the `.sha256` sidecar and the
   `versions.yaml` row. (See #2741 for why the blob must not stay on checkout.)
5. Add an OID-keyed branch to `scripts/fetch-lfs-blob.sh` (or generalise it) so
   the new archive is retrievable on demand.

**Why not LFS-on-checkout:** every `lfs: true` checkout pulls the full blob and
bills the repo owner for LFS bandwidth — even on public repos and PRs from
forks. At ~80–100 CI runs/month a 59 MB blob blew past the 1 GB/mo allowance and
403'd the smudge, failing unrelated CI (#2741). Keep blobs out of HEAD; fetch on
demand.
