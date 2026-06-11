# WS-patch investigation: claude-code 2.1.120 → 2.1.173

Goal (per #1808 follow-up): make the `claude-patch` strategy registry cover
**every** claude-code version between 2.1.120 and 2.1.173 so mcx can spawn a
patched binary that accepts `--sdk-url` pointing at the local daemon.

## Background

The host-check lockdown landed in **2.1.120**. Post-lockdown, the binary builds
a 5-host allowlist at runtime and rejects `--sdk-url` whose host isn't on it.
The `STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1` strategy defeats this by rewriting
the fedstart staging hostname `claude-staging.fedstart.com` (27 bytes) to the
IPv6-loopback literal `[000:000:000:000:000:0:0:1]` (27 bytes, canonicalizes to
`[::1]`). It asserts **exactly 4 occurrences** of the source string and was
validated end-to-end against 2.1.121 and 2.1.123.

## The problem this investigation found

The fedstart occurrence count is **not stable across the range**. Spot-checks:

- 2.1.120, 2.1.121: **4** occurrences (v1 strategy validates)
- 2.1.156, 157, 169, 170, 172, 173: **3** occurrences (v1 strategy `validate`
  asserts 4 → **throws at patch time** → patcher refuses to produce a binary)

So the existing strategy already fails somewhere below 2.1.156. We need to:

1. Find the exact boundary version where count 4 → 3 (and any other counts).
2. Confirm, by decompiling, that replacing all-N occurrences still defeats the
   host check on the 3-occurrence binaries (the allowlist construction may have
   changed — fewer fedstart origins, or a different gate entirely).
3. Either relax v1's `validate` to accept the real count per version range, or
   author a v2 strategy with the correct count + any new byte edits, with tight
   `matches` bounds so the right strategy wins per version.

## Layout

- `triage.ts` — downloads each version's darwin-arm64 binary (reusing local
  copies under `~/.local/share/claude/versions` and the repo LFS archive),
  counts the key byte-signatures, dumps a per-version `notes/<version>.scan.json`
  and a `notes/_summary.md` table. Cheap first pass.
- `binaries/<version>` — the binary (or a symlink to a local copy). Git-ignored.
- `notes/<version>.scan.json` — machine-readable scan record per version.
- `notes/<version>.md` — human deep-dive notes (written by nerd-snipe agents
  when a version needs decompilation). **If we ever revisit a version, read its
  note first.**
- `notes/_summary.md` / `_summary.json` — the triage table across all versions.
- `FINDINGS.md` — the final conclusion: which strategy covers which version
  range, where v1 ends, where v2 begins.

## Scan signatures (what each column means)

- `fedstart` — occurrences of `claude-staging.fedstart.com`. The v1 strategy
  replaces these. Count drives `validate`.
- `prod` / `staging` — occurrences of `api.anthropic.com` /
  `api-staging.anthropic.com`, the two hardcoded allowlist hosts. Tracks whether
  the allowlist source changed shape.
- `replacement` — occurrences of the IPv6 literal. Must be 0 on an unpatched
  binary (sanity that we're scanning the source, not an already-patched copy).
- `v1-validates` — would `STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1.validate` pass?
  (fedstart == 4 and replacement == 0).
