# Mechanism: why fedstart 4→3, and the strategies.ts fix

## Conclusion (de-dup hypothesis: CONFIRMED, with one correction)

The 4→3 drop at the **2.1.132 → 2.1.133** boundary is **pure de-duplication of a
doubly-bundled JS chunk**. Nothing about the host-check changed semantically.

- **2.1.120 .. 2.1.132 (count = 4):** the host-check chunk (gate fn + Set builder
  + fedstart-origins source array) is bundled **twice** (byte-identical copies).
  Each copy contributes 1 live source-array `fedstart` occurrence → **2 live**.
  Plus **2 dead string-table atoms** = 4.
- **2.1.133 .. 2.1.173 (count = 3):** a bundler/minify rebuild (218→204 MB,
  `api.anthropic.com` 120→69, all minified idents renamed) collapsed the
  duplicate chunk to **one** copy → **1 live** source array + the same **2 dead
  atoms** = 3.

So across the whole range the decomposition is:
```
fedstart_total = (live source-array copies) + 2 dead atoms
4-era: 2 live + 2 atoms
3-era: 1 live + 2 atoms
```
Verified by signature counts on every present binary 2.1.120–2.1.173 (see
`_summary.md`): `liveGates == setBuilders(...map) == (fedstart_total - 2)`,
which is 2 for the 4-era and 1 for the 3-era, uniformly.

### Correction to the orchestrator's hypothesis
The function adjacent to the source array (`_j4` in .132 / `GD4` in .133) is the
**chalk / ansi-colors** module, NOT the allowlist builder. It builds a `Map` of
ANSI escape codes (`H.set(O[0],O[1])` over color tables) and only sits
*textually next to* the origins array in the bundle. The REAL allowlist builder
and gate are:

| role                         | 2.1.132 | 2.1.133 |
|------------------------------|---------|---------|
| gate fn (`new URL`, `.has`)  | `A0K`   | `B0K`   |
| allowlist `Set<hostname>`    | `hZ3`   | `$k3`   |
| Set-builder thunk            | `z0K`   | `U0K`   |
| fedstart-origins array       | `LN_`   | `QN_`   |
| (chalk, adjacency red herring) | `_j4` | `GD4`   |

The gate (identical in both):
```js
function GATE(H){
  let _; try{_=new URL(H)}catch{return "...could not parse..."}
  if(SET.has(_.hostname)){
    if(_.protocol!=="wss:"&&_.protocol!=="https:") return "...scheme not permitted...";
    return null;  // approved
  }
  return `host ... is not an approved Anthropic endpoint`;
}
SET = new Set([
  "api.anthropic.com","api-staging.anthropic.com",
  ...ORIGINS.map((H)=>new URL(H).hostname)   // ORIGINS = LN_ / QN_
]);
```

## Does v1's transform still work on the 3-count binary? YES.

The gate consumes the **live source-array literal** (`LN_`/`QN_`), not the dead
atoms. v1 rewrites every `claude-staging.fedstart.com` → `[000:...:1]`, which
includes the live array literal. Empirically:

```
2.1.132: replacementCount=4, liveArrayLiteralReplaced=2, canonHostname=[::1]
2.1.133: replacementCount=3, liveArrayLiteralReplaced=1, canonHostname=[::1]
```

`new URL("https://[000:000:000:000:000:0:0:1]").hostname === "[::1]"` (WHATWG
canonicalization). After the patch, `[::1]` is a member of the live allowlist
`Set` on both versions. The **transform is correct on 3-count binaries**; only
v1's `validate` (`after !== 4` → throw) is wrong. The dead atoms are irrelevant
to the gate — replacing them is harmless and replacing the live array is what
matters.

## Recommended fix: relax `validate` to be count-tolerant (NOT a v2 strategy)

A v2 strategy is **not** warranted: the `apply` transform is byte-for-byte
correct across the entire 2.1.120–2.1.173 range; nothing new needs editing. The
only defect is a brittle exact-count assertion. The boundary (4→3) is a pure
bundler artifact and Anthropic ships multiple builds/day, so the count must be
treated as *variable*, asserted by **shape** not by a magic number.

### Exact replacement for `validate` in `STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1`

The invariant that actually matters:
1. **zero** unreplaced source strings remain (the transform ran to completion), and
2. **at least one** replacement landed inside the **live source-array literal**
   — i.e. the array that the allowlist builder `.map`s over. We detect that by
   matching the array-literal context that survives the rewrite:
   `claude.fedstart.com","https://[000:000:000:000:000:0:0:1]"`.

This is count-tolerant (works for the 2-live-copy era and the 1-live-copy era,
and any future N), yet still fails loudly if a rebuild moves the staging origin
out of the `.map`ed array (the only change that would actually break the gate).

```ts
  validate: (patched) => {
    const find = enc.encode("claude-staging.fedstart.com");
    const replace = enc.encode("[000:000:000:000:000:0:0:1]");
    // The live allowlist is built from the fedstart-origins ARRAY LITERAL via
    // `...ORIGINS.map(H => new URL(H).hostname)`. Post-patch, the staging origin
    // in that array reads `"https://[000:...:1]"` right after the prod origin.
    // Matching that context proves we rewrote the *live* origin, not just a
    // dead string-table atom. This is the load-bearing check.
    const liveArrayCtx = enc.encode('claude.fedstart.com","https://[000:000:000:000:000:0:0:1]"');

    const before = countOccurrences(patched, find);
    if (before !== 0) {
      return { ok: false, reason: `${before} unreplaced occurrences of source string remain` };
    }
    const after = countOccurrences(patched, replace);
    if (after < 1) {
      return { ok: false, reason: "no replacement occurrences found (source string not present?)" };
    }
    const liveHits = countOccurrences(patched, liveArrayCtx);
    if (liveHits < 1) {
      return {
        ok: false,
        reason:
          "staging fedstart origin not found in the live allowlist array literal " +
          "after patch — binary may have reshaped the host check (file an issue)",
      };
    }
    return { ok: true };
  },
```

Why this over a bare `after >= 1`: a bare count check would pass even if the
*only* rewritten occurrences were the dead string-table atoms (a future build
could drop the live array entirely and keep the atoms). The `liveArrayCtx`
check ties validation to the exact construct the gate consumes, so it fails
closed on a genuine reshape while tolerating the dup-count swing.

Optionally also update the strategy's doc comment, which currently says
"4 sites in 2.1.121" and "asserts exactly 4 replacements" — replace with: the
live allowlist is built from the fedstart-origins array literal; the patch
rewrites the staging origin there (plus harmless dead atoms / duplicate bundle
copies), and `validate` asserts the live array literal was rewritten rather than
a fixed count (count varies: 4 in 2.1.120–.132, 3 in 2.1.133+, due to bundle
de-dup).

### `matches` bounds — leave as-is
Keep the lower-bound-only `>= 2.1.120`. No upper bound, no per-era split. The
shape-based `validate` is the safety net for any future reshape.
