# Range stability: 2.1.133 → 2.1.173 (the 3-occurrence era)

**VERDICT: ONE strategy covers 2.1.133–2.1.173. No mechanism divergence in any
sampled version.** The host-check allowlist construction and the 3
`claude-staging.fedstart.com` occurrence sites are structurally identical across
the entire range; only minifier-assigned identifiers churn. The only fix needed
is relaxing v1's `validate` from `=== 4` to the per-era count (3 here; >=1 live
array hit is the robust invariant).

Sampled (representative): 2.1.132 (reference, count=4), 2.1.133, 2.1.140,
2.1.150, 2.1.160, 2.1.168, 2.1.173. Plus structural spot-confirms on the Set
builder / validator / gate.

## The complete host-check mechanism (invariant across all versions)

Three linked pieces, all proven present and identical in every sampled binary:

1. **Source array** (the thing the patch rewrites), always exactly:
   ```js
   ARR = ["https://beacon.claude-ai.staging.ant.dev",
          "https://claude.fedstart.com",
          "https://claude-staging.fedstart.com"]
   ```
   Byte-identical (same 3 origins, same order) in 132/133/140/150/160/168/173.
   `ARR` is a minifier identifier that churns: `LN_`→`QN_`→`TE_`→`Fu_`→`CF_`→
   `bc_`→`_r_`. This array is also exposed as `ALLOWED_OAUTH_BASE_URLS`.

2. **Allowlist Set builder** (consumes the array), always exactly:
   ```js
   SET = new Set(["api.anthropic.com","api-staging.anthropic.com",
                  ...ARR.map((H)=>new URL(H).hostname)])
   ```
   = 2 hardcoded hosts + 3 hostnames spread from ARR = 5-host allowlist.
   Exactly ONE such builder per binary in every version (grep count = 1).

3. **Validator + gate** (reads the Set), always exactly:
   ```js
   function VALIDATOR(H){
     let _; try{_=new URL(H)}catch{return `could not parse ... as a URL`}
     if(SET.has(_.hostname)){
       if(_.protocol!=="wss:"&&_.protocol!=="https:")
         return `scheme ... is not permitted ...; only wss:// and https:// are accepted`;
       return null;            // ACCEPT
     }
     return `host ${_.hostname} is not an approved Anthropic endpoint`;
   }
   // gate:
   let r = VALIDATOR(sdkUrlArg);
   if(r!==null) return ...tengu_sdk_url_host_rejected...,
                       Eq(`Error: --sdk-url rejected: ${r}. ...`);
   ```
   Validator id churns: `A0K`→`QvK`→`RtK`→`VO4`→`FJ4`→`TG4`. Set holder churns:
   `hZ3`→`$k3`→`Yx3`→`JAO`→`Sx3`→`oi3`→`A7T`.

**Why the patch works (unchanged across range):** rewriting
`claude-staging.fedstart.com` → `[000:000:000:000:000:0:0:1]` in ARR makes
`new URL("https://[000:000:000:000:000:0:0:1]").hostname === "[::1]"`, so
`SET.has("[::1]")` is true → mcx's daemon URL passes the gate (subject to the
wss:/https: scheme constraint, which is itself invariant).

## The 4→3 count drop is pure de-duplication (confirmed)

At 2.1.132 the entire module defining ARR is **bundled twice** (two identical
copies at offsets ~73M and ~198M), so the JS array literal of
`claude-staging.fedstart.com` appears twice; plus 2 inert string-table atoms =
**4**. At 2.1.133 the bundler emits the module **once** = 1 array literal + 2
atoms = **3**. The 218→204MB shrink at 2.1.133 is this rebuild. The *live*
allowlist (one Set builder, one validator) was single-copy the whole time —
the second array copy at 132 was dead weight, not a second gate.

## Occurrence classification (unanimous across the range)

| version | count | LIVE JS array literals | string-table atoms |
|---------|-------|------------------------|--------------------|
| 2.1.132 | 4     | 2 (doubly-bundled)     | 2                  |
| 2.1.133 | 3     | 1                      | 2                  |
| 2.1.140 | 3     | 1                      | 2                  |
| 2.1.150 | 3     | 1                      | 2                  |
| 2.1.160 | 3     | 1                      | 2                  |
| 2.1.168 | 3     | 1                      | 2                  |
| 2.1.173 | 3     | 1                      | 2                  |

The two atoms are an inert deduped copy of the 3 origins in Bun's constant pool
(no surrounding code; not read by the live check). The patch rewrites them too,
harmlessly and length-preservingly. Only the **1 live array literal** matters
for neutralizing the gate — so the robust validate invariant is "source string
gone AND >= 1 replacement at the live array site", not a brittle exact count.

## Non-divergences (things that changed but do NOT affect the mechanism)

- **Adjacent function after the array.** The `]});function <X>(){...` that
  follows the array is NOT the allowlist builder — at <=2.1.160 it's the
  ansi-styles `H=new Map` color-codes function; at 2.1.168/173 the minifier put
  `function <x>(){return!0}function <y>(){return Arra...` there instead. Purely
  cosmetic adjacency; the patch keys on `claude-staging.fedstart.com`, not on
  the following token. (NB: SHARED-CONTEXT's "GD4/_j4 builds a Map over the
  origins array" framing is a red herring — that Map is ANSI color codes. The
  real builder is the separate `new Set([...])`.)
- **Telemetry teardown refactor at 2.1.168+.** The reject branch changed from
  `d("tengu_sdk_url_host_rejected",{}),await Promise.race([...teardown...])` to
  `await Hh("tengu_sdk_url_host_rejected",{})` (168) / `await aV(...)` (173),
  dropping the Promise.race teardown. This is downstream of the reject decision
  and irrelevant to the allowlist check.
- **hostProd/hostStaging count drift** (69→61→62→65→67→68 etc.). These are
  whole-bundle counts of `api.anthropic.com` / `api-staging.anthropic.com`
  across all of claude's code, NOT the 2-host allowlist seed. The seed pair
  inside `new Set([...])` is present and identical in every version. The drift
  is unrelated code churn.
- **`ccr-session host requires --sdk-url`** (new atom at 2.1.160+) is a CLI
  usage error string with no surrounding gate code — not a second host check.
- **Size growth 204→223MB** across .133–.173 is general bundle growth; the
  fedstart mechanism is unaffected.

## Recommendation

Relax `STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1.validate`: drop the `after === 4`
assertion. The correct, future-proof invariant is:
- `before === 0` (source string fully gone), AND
- `after >= 1` (at least the live array literal was rewritten).

A tighter form that still tolerates the de-dup is `after === 3 || after === 4`,
but `>= 1` is the principled choice because only the live JS array hit is
load-bearing; the atom count is an artifact of Bun's constant-pool emission and
could change again without affecting the gate. No `apply` change and no v2
strategy is needed for 2.1.133–2.1.173 — one transform covers the whole range.
