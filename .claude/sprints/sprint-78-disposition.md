# Finding disposition against the (a)/(b)/(c) bar

Auditor pass, 22:2xZ. Corpus: `build/sprint-78-reviews.json` (18 PRs, 98 items, refreshed 22:1xZ).
Read-only; no sessions spawned, no gate runs, no labels touched.

**Bar:** BLOCKS only if (a) data loss, (b) security/containment, (c) regression to *shipped*
behaviour. Everything else FILE.

**Trust filter result, stated up front:** 7 edited-after-posting bodies detected. Five long-gap
edits are all on **merged** PRs (#3143, #3127, #3125, #3113, #2964) and are outside this
disposition set. The only edited bodies in scope are **#3168 c5/c6, edited 1 and 6 minutes after
posting** — typo-scale, trustworthy per the filter. **No finding below rests on a distrusted
body.**

---

## #3137 — issue #3119 · head unreviewed since 14:35 · DIRTY, oldest

    #3137  BLOCKS(c)?  ws-server.ts (restoreSessions)  F3: restore predicts childGated:true for an uncontained session; an sdk-url child surviving daemon restart round-tripped can_use_tool pre-PR and is now DENIED every time — reviewer marked READ-ONLY, NOT REPRODUCED
    #3137  FILE        session-state (handlePermissionDenied)  F1: denial event drops `message`; operator gets tool name and no reason. New event, not shipped behaviour → not (c)
    #3137  FILE        ws-server.ts:1326                F2: version gate reads this.claudeVersion while spawn uses session.config.binaryPath; `--permission-mode auto` can reach an unchecked binary. Narrow (needs explicit override + explicit auto); a spawn crash, not a containment breach
    #3137  SUMMARY     1 unproven blocker (1c), 2 file-and-drop

F3 is the only candidate and it is a genuine (c) *shape* — behaviour that worked before does not
now — but the reviewer explicitly did not drive it. It is also fail-closed, so the failure mode is
a dead session rather than an escaped capability.

---

## #3160 — issue #3035 · head `dea17202` (21:48) · CRITICAL PATH for epic A

    #3160  CLOSED   import-legacy.ts        N1/N2/N11 — all three 🔴 addressed at `dea17202`, with driven evidence: forced one table to error, showed 0 rows on disk and marker unset, so the transaction IS all-or-nothing and the DOCS were the defect. Reworded :23/:167/:172
    #3160  FILE     import-legacy.spec.ts:1153,:1225  N3: reverting #3143's clamp fix breaks zero tests — test quality
    #3160  FILE     import-legacy.ts:87-103           N4: clearImportMarker omits the busy_timeout its sibling sets at :233
    #3160  FILE     handlers/domain.ts:118-124        N5: `rm --cascade` launders genuine SQLite errors into "re-run with --force"
    #3160  FILE     domain.spec.ts:29                 NEW-1: CLI spec harness untyped; a fixture can assert a shape production cannot return
    #3160  FILE     (tracked #3170)                   totalCopied:4 printed beside 0 rows on disk — reproduced live, not fixed here
    #3160  SUMMARY  0 blockers, 5 file-and-drop

**No review has run against `dea17202`.** The blocker closures rest on the implementer's own driven
probes — which are the strongest evidence in the corpus (on-disk row counts, marker presence,
boot-to-boot retry traces), but they are self-reported.

---

## #3168 — issue #3039 · head `ac7e21e0` (22:05)

    #3168  CLOSED   claude.ts / toDomainFilter   #3199 `bye --all` machine-wide — was BLOCKS(b) (destructive command reachable by accident). Fixed at the COLLAPSE, not the call site: resolveDomainFilter now returns a discriminated {none|unresolved|domain} and destructive callers set requireScope
    #3168  FILE     session-scope (cross-surface)  🟡 the `mcx claude ls` ≡ `mcx agent claude ls` equivalence guard is vacuous and the divergence it was written to catch is live. Non-destructive surface, errs narrower
    #3168  SUMMARY  0 open blockers, 1 file-and-drop

**The (b) fix at `ac7e21e0` is implementer-verified only** — no review round has touched it, and the
freeze means none will. It is the correct architectural fix (attacks the two-conditions-one-answer
collapse rather than guarding one verb), which is exactly what I would want; but "correct-looking
fix, unverified" is the shape that cost this sprint 30 rounds.

---

## #3169 — issue #3040 · head `6c667ce3` / `3a5a8d21` (19:52)

    #3169  FILE     adopt-domains.ts   🔴 one colliding key strands its non-colliding siblings, defeating adoption on the boxes it exists for. Adoption is a NEW feature — nothing destroyed, nothing regressed, no containment boundary → does not meet the bar despite the 🔴
    #3169  FILE     adopt-domains.spec.ts:111-126  🟡 the collision spec is vacuous by construction
    #3169  FILE     adopt-domains.spec.ts:61       🟡 monitor_events adoption never exercised by a test
    #3169  SUMMARY  0 blockers, 3 file-and-drop

R1–R7 all closed and verified across three review deltas. The remaining 🔴 is severity-real but
category-miss under the new bar; flagging that explicitly because a reader scanning for red
emoji will reach the wrong conclusion.

---

## #3175 — issue #3037 · head `65593efa` · **CONTESTED**

    #3175  CONTESTED  head 65593efa    c6 (21:25) "✅ APPROVED — blocker and both should-fixes resolved, pinned by mutation-tested specs" vs c7 (21:28) "⚠️ Changes Requested — 2 blockers, BOTH NEW IN THIS HEAD, introduced by the round-3 fix itself". Not adjudicating — yours.
    #3175  BLOCKS(c)  domainStateRoot   Finding 1: reads phase state under a root no writer writes to. Driven and real, but needs domain.path to be a STRICT ANCESTOR of the caller's git root — legal, not demonstrated on any live box (`gerald` is at a repo root). In the flagship case this PR FIXES the read
    #3175  FILE       automation dispatcher (ctx.repoRoot)  Finding 5: ctx.repoRoot stays daemon-cwd while ctx.state goes per-row → cross-domain-leak SHAPE, category (b), but no module was found that reaches it and the ctx.repoRoot half is unchanged from main. Reviewer declined to call (b) on an undemonstrated hazard — I agree
    #3175  FILE       ipc.ts:932        Finding 2: stranding report false-positives under --phase. New message, new behaviour
    #3175  FILE       --json / ls / sprint-stats  Finding 3: report invisible in three surfaces. Gap in a new feature
    #3175  FILE       track.spec.ts     Finding 4: guard untested at the shipping layer — test quality
    #3175  FILE       PR body           Finding 6: missing classification table, stale commit claim — docs
    #3175  FILE       #3192             Finding 7: duplicates #3041, stale — process
    #3175  SUMMARY    1 narrow blocker (1c) + 1 unproven (b), 5 file-and-drop

The contest partly self-resolves: c7's own author re-scored at 22:08 and concluded five of six no
longer block, leaving only finding 1. So the live disagreement is narrower than "approved vs
changes requested" — it is c6 saying zero and c7-as-amended saying one narrow (c).

---

## #3181 — issue #3043 · head `7a59b17a`

    #3181  CLOSED   domain-supervisor  Both 🔴 (A: ensure() drops a `restarting` server, resets crash budget; B: giveUp() overwrites terminal `stopped`) — reviewer self-re-classified at 22:08: neither is data loss, neither crosses containment, and neither regresses SHIPPED behaviour (they regress an earlier commit inside this same unmerged PR)
    #3181  FILE     domain-supervisor  6 🟡 (C–I) + 🔵 — all filed against #3044's epic
    #3181  SUMMARY  0 blockers, 6+ file-and-drop

Decisive evidence, and it is the cleanest reasoning in the corpus: `rg 'domainSupervisor\.(ensure|
ensureByName|status|list)' --type ts | grep -v spec` returns **no matches**. `sync()` and
`stopAll()` iterate a map that stays empty until #3044 adds the first caller. Unreachable in
production by construction. Label already flipped to `review:pass`.

---

## #3200 — issue **#3038** (mail scoping) · head `8677900f` (21:24) · newest, opened 19:10

    #3200  BLOCKS(a)  mail-domain.ts / import-legacy.ts  🔴1: mail dies on the next mcpd restart with no user action, stranding 56 rows with no recovery path — CLAIMED FIXED at 8677900f (partition 0 made first-class, reserved name `_`), UNREVIEWED
    #3200  BLOCKS(a)  state.ts:478-481                   🔴2: schema change sits in applyV1Schema() with no version bump — never runs on an existing mcx.db, and tests can never catch it — CLAIMED FIXED (moved to `if (version < 8)`), UNREVIEWED
    #3200  BLOCKS(b)  mail-domain.ts                     🔴3: a sender smuggles a domain through the local part; the victim's reply crosses the partition boundary — CLAIMED FIXED (local part may no longer contain `@`; parse-then-reject), UNREVIEWED
    #3200  BLOCKS(a)  handlers/mail.ts:105               🔴4: markRead discards the boolean the DB layer produces; a cross-partition mark-read reports success — CLAIMED FIXED, UNREVIEWED
    #3200  FILE       mail-domain.ts:174-178             🟡5: unassigned-sender guard unreachable; its only coverage is a state StateDb cannot produce
    #3200  FILE       (host-bound / mcpctl / docs / mail.ts:299-302)  🟡6–9
    #3200  SUMMARY    4 blockers (3a, 1b) — all CLAIMED FIXED, NONE VERIFIED, 5 file-and-drop

Two aggravating facts: the branch was **force-pushed** after rebase, so the reviewed SHAs
`2272b969`/`2ecb6c30` are gone from the branch (timeline only) — a re-review cannot diff against
what was reviewed. And the author states it is **sequenced behind #3035/#3160 and must not merge
ahead of it**, so parking costs nothing.

---

# Disposition table

| PR | Issue | Blockers by letter | Open non-blocking | My recommendation |
|---|---|---|---|---|
| **#3181** | 3043 | — | 6+ | **MERGE** — unreachability proven by construction, reviewer already at `review:pass` |
| **#3169** | 3040 | — | 3 | **MERGE** — R1–R7 closed across three verified deltas; the residual 🔴 misses the bar |
| **#3160** | 3035 | — | 5 | **MERGE FIRST** — critical path; three 🔴 closed with the strongest driven evidence in the corpus. #3175/#3200 sequence behind it |
| **#3168** | 3039 | — (b) closed | 1 | **MERGE** — but re-run the #3199 repro against main after merge. One command, not a review round |
| **#3175** | 3037 | 1×(c) narrow | 5+1 unproven (b) | **MERGE** — finding 1's precondition (domain.path strict ancestor of git root) is not present on this box and the PR repairs the flagship path. Genuine (c), so it is a risk call, not a correctness call. Follow-up is one line: assert `domain.path` is the root writers key under |
| **#3137** | 3119 | 1×(c) unproven | 2 | **SIMPLIFY-ONCE** — oldest and DIRTY. F3 is fail-closed so the blast radius is a dead session, but it is the only unproven (c) sitting on a *restore* path. Cheapest resolution is driving F3 once, not another round |
| **#3200** | **3038** | 3×(a) + 1×(b) | 5 | **PARK** — four genuine (a)/(b) findings, all four fixes claimed but unverified, branch force-pushed so the reviewed SHAs are gone, and it cannot merge before #3160 regardless. Parking is free here |

**Merge order, if you take the above:** #3160 → then #3181, #3169, #3168 in any order → #3175 →
(#3200 after a verification pass, whenever the freeze lifts).

---

## Three things I want on the record

1. **#3200 is #3038** — the issue my 16:46 audit reported as silently dropped in the 09:52–13:20
   stall. It was picked up ~9 hours later (PR opened 19:10). The audit's finding stands as a
   description of the stall's cost; the "never dispatched" status is superseded. I will correct it
   in the re-run.

2. **Five of the seven PRs rest on unverified heads**, because the freeze arrived between the last
   push and the next review. That is the correct trade — the freeze exists because verification was
   costing more than it returned — but it means the disposition is "no *known* blocker" rather than
   "verified clean". #3168's (b) fix and #3200's four are where that gap is load-bearing.

3. **The two reviewers who re-scored their own findings against the new bar (#3181, #3175 at 22:08)
   produced the most useful artefacts in the corpus.** Both narrowed or withdrew their own
   blockers, with evidence, unprompted. #3181's `rg` returning no matches is a one-line proof of
   unreachability that closes two 🔴s. If the bar change is worth repeating in a future sprint, the
   thing to repeat is asking authors to re-score their own findings rather than having a third
   party do it.
