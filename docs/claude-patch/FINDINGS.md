# Claude `--sdk-url` host-check patcher — version coverage 2.1.120 → 2.1.173

**Bottom line:** the existing patch strategy
(`STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1` in
`packages/core/src/claude-patch/strategies.ts`) covers **every published
claude-code version from 2.1.120 through 2.1.173 with a single byte transform**.
No new transform and no v2 strategy are needed. The only defect was a brittle
`validate` that asserted *exactly 4* occurrences of the rewritten string; that
assertion broke at **2.1.133**, where a bundler de-dup dropped the count to 3.
Relaxing `validate` to a shape-based check fixes the whole range.

## Direct answers to the investigation questions

- **Can the latest versions be patched for WS?** Yes — proven end-to-end. A
  patched + re-signed **2.1.173** accepts a `wss://[::1]` `--sdk-url` (enters
  `SDKStartup: phase=connecting_transport`), whereas the unpatched binary
  rejects it with `host "[::1]" is not an approved Anthropic endpoint`. Same
  result confirmed on **2.1.133** (the lower edge of the changed era). See
  `notes/functional-2.1.173.md` and `notes/functional-2.1.133.md`.
- **Where does the existing patcher work until?** The `apply` transform works
  for the entire range. The existing `validate` (`=== 4`) passes only for
  **2.1.120 – 2.1.132** (last 4-count version: **2.1.132**).
- **Where does the new patcher need to start?** **2.1.133** (first 3-count
  version) — but it is the *same* transform with a relaxed `validate`, not a
  separate strategy. One strategy now covers 2.1.120 – 2.1.173.

## The boundary, in one table

| occurrences of `claude-staging.fedstart.com` | versions | old `validate` (`=== 4`) |
|---|---|---|
| 4 (2 live array literals + 2 inert atoms) | 2.1.120 – 2.1.132 | ✓ passes |
| 3 (1 live array literal + 2 inert atoms) | 2.1.133 – 2.1.173 | ✗ throws `expected 4, found 3` |

The 4→3 drop at 2.1.133 is a **pure bundler de-duplication** of a
doubly-bundled JS chunk (binary also shrank 218→204 MB) — the host-check logic
is byte-identical across the boundary. Confirmed structurally on 2.1.132 / .133
/ .140 / .150 / .160 / .168 / .173 and functionally on .133 / .173.

## The mechanism (invariant across the whole range)

```js
// source-array literal (minified var name churns: LN_→QN_→TE_→Fu_→CF_→bc_→_r_)
ORIGINS = ["https://beacon.claude-ai.staging.ant.dev",
           "https://claude.fedstart.com",
           "https://claude-staging.fedstart.com"]
// allowlist builder — exactly one per binary
SET = new Set(["api.anthropic.com","api-staging.anthropic.com",
               ...ORIGINS.map(H => new URL(H).hostname)])
// --sdk-url gate — exactly one per binary
function GATE(H){ const u=new URL(H);
  if(SET.has(u.hostname)){ if(u.protocol!=="wss:"&&u.protocol!=="https:") return "scheme … not permitted"; return null; }
  return `host ${u.hostname} is not an approved Anthropic endpoint`; }
```

The patch rewrites `claude-staging.fedstart.com` → `[000:000:000:000:000:0:0:1]`
in the live ORIGINS array; `new URL("https://[000:000:000:000:000:0:0:1]").hostname
=== "[::1]"`, so `[::1]` joins the allowlist `Set`. The gate's `wss:`/`https:`
scheme constraint is why mcx connects over **TLS `wss://[::1]:PORT`** (already
the case per #1808). The two inert string-table atoms are a constant-pool copy
not read by the gate — rewriting them is harmless.

## The fix (shipped on this branch)

`STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1.validate` now asserts by **shape**:
1. zero unreplaced source strings remain, and
2. ≥1 replacement landed inside the **live ORIGINS array literal** — detected
   via the array context `claude.fedstart.com","https://[000:…:1]"`.

This tolerates the dup-count swing (4 or 3 or any future N) yet still fails
loudly on a genuine reshape (a build that moves the staging origin out of the
`.map`ed array — the only change that would actually break the gate). `matches`
stays lower-bound-only (`≥ 2.1.120`). See `notes/mechanism.md` for the full
rationale and the exact code.

## Coverage of the requested range

Published & covered (45 versions): 2.1.120–.124, .126, .128, .129, .131–.133,
.136–.150, .152–.154, .156–.163, .165–.170, .172, .173.
**Never published (HTTP 404, nothing to cover):** 2.1.125, .127, .130, .134,
.135, .151, .155, .164, .171.

## How to revisit a version

- `notes/_summary.md` — the full triage table (counts per version).
- `notes/<version>.md` — per-version deep-dive (offsets, gate code slices).
- `notes/<version>.scan.json` — raw scan (counts, byte offsets, printable
  contexts) for each version; `notes/_summary.json` is the aggregate.
- `triage.ts` — re-download + re-scan any range:
  `bun triage.ts 133 173`. `slice.ts` — printable byte-window extractor.
- Download a single binary:
  `curl -fsSL -o binaries/<v> "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/<v>/darwin-arm64/claude"`
