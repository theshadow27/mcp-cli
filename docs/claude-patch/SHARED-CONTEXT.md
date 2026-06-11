# Shared context for ws-patch nerd-snipe agents

Read this first. It's the orchestrator's triage output; your job is the deep
confirmation it can't do from byte-counts alone.

## The patcher you're validating

`packages/core/src/claude-patch/strategies.ts` →
`STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1`:
- **apply**: replace every `claude-staging.fedstart.com` (27 bytes) with
  `[000:000:000:000:000:0:0:1]` (27 bytes; canonicalizes to `[::1]` via WHATWG
  URL parsing). Length-preserving.
- **validate**: asserts the source string is gone AND **exactly 4** copies of
  the replacement exist. This hard `=== 4` is what breaks on newer binaries.
- **why it works**: post-2.1.120 claude builds a 5-host allowlist for
  `--sdk-url` from two hardcoded hosts (`api.anthropic.com`,
  `api-staging.anthropic.com`) plus fedstart origins spread from an `sL_`-style
  source array via `new URL(H).hostname`. Rewriting the staging fedstart origin
  to `[::1]` makes localhost an allowlisted host, so mcx's daemon at
  `ws://[::1]:PORT` passes the check.

## Triage results (orchestrator already established)

- **fedstart-count = 4**: versions **2.1.120 .. 2.1.132** → v1 `validate` passes.
- **fedstart-count = 3**: versions **2.1.133 .. 2.1.173** → v1 `validate` THROWS
  (`expected 4 replacement occurrences, found 3`), so the patcher refuses to
  produce a binary even though the transform itself ran.
- **Unpublished (HTTP 404, skip these): 2.1.125, .127, .130, .134, .135, .151,
  .155, .164, .171.**
- At 2.1.133 the binary shrank 218MB→204MB and `api.anthropic.com` occurrences
  dropped 120→69 — a bundler/minify rebuild.

### Byte-context the orchestrator captured at the boundary

2.1.132 (count=4) — note TWO identical JS source-array copies + two atoms:
```
0 ...fedstart.com","https://claude-staging.fedstart.com"]});function _j4(){let H=new Map;for(let[_,q]of Obje   <- JS source array copy #1
1 claude.fedstart.com·····#···https://claude-staging.fedstart.com·····0···`···                                 <- string-table atom
2 claude.fedstart.com·····#···https://claude-staging.fedstart.com·····                                         <- string-table atom
3 ...fedstart.com","https://claude-staging.fedstart.com"]});function _j4(){let H=new Map;for(let[_,q]of Obje   <- JS source array copy #2 (identical)
```
2.1.133 (count=3) — ONE source-array copy (func renamed `GD4`) + same two atoms:
```
0 claude.fedstart.com·····#···https://claude-staging.fedstart.com·····0···`···                                 <- string-table atom
1 claude.fedstart.com·····#···https://claude-staging.fedstart.com·····                                         <- string-table atom
2 ...fedstart.com","https://claude-staging.fedstart.com"]});function GD4(){let H=new Map;for(let[_,q]of Obje   <- JS source array copy (only one now)
```

**Hypothesis to confirm or kill:** the 4→3 drop is pure de-duplication of a
doubly-bundled JS chunk; the *live* allowlist construction (`_j4`/`GD4`,
building a Map over the origins array) is unchanged and still rewrites to
`[::1]`. If true, the fix is to relax `validate` to accept the per-era count
(or `>= 1` live source-array hit), not a new transform.

## Tools & data available to you

- Binaries: `binaries/<version>` (symlink to local copy or downloaded). Range
  2.1.120-2.1.173 are present except the 404s above.
- Per-version scan: `notes/<version>.scan.json` (counts, byte offsets,
  printable contexts).
- `triage.ts` — re-run / extend for more signatures if useful.
- Download any version: `curl -fsSL -o binaries/<v> \
  "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/<v>/darwin-arm64/claude"`

## Extracting the JS bundle (faster than full disassembly)

These are Bun-compiled binaries: the JS bundle is embedded as plaintext. You do
NOT need a disassembler. To pull the allowlist code:
- Find the source-array offset (in `scan.json.fedstartOffsets`, the entry whose
  context contains `]});function`), then dump a window around it:
  `dd if=binaries/<v> bs=1 skip=<offset-4000> count=12000 2>/dev/null | strings -` —
  or use a bun script to slice `readFileSync(bin).subarray(off-6000, off+6000)`
  and print the printable run. The `new URL(H).hostname` allowlist builder and
  the host-check call site live in that chunk.
- Grep the slice for the two hardcoded hosts and `new URL(` / `.hostname` /
  `--sdk-url` / `sdkUrl` to find the actual gate.

## Write your notes here

- `notes/<version>.md` — per-version deep-dive. Start with a one-line verdict
  (does v1's transform still neutralize the gate? what count?), then evidence
  (offsets, the allowlist code slice, the host-check call site).
- If you confirm/kill the de-dup hypothesis, write it in `notes/mechanism.md`.
- End-to-end proof (if you do it): record exact commands + result.
