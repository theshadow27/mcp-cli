# mcx-boss — live state

**Read this first after a compaction or a session restart.** Rewritten 2026-08-24
during the post-sprint-79 recovery re-plan; MVP-1 section updated 2026-08-26 at
sprint-81 planning. This is the durable record of
*operational* state; the plan of record is the recovery comment on #3019, and the
lessons live in `.claude/memory/`.

## The job

One supervisor context (this one) plans and adjusts between sprints, keeps a pulse
via the retro diary + this file + the `boss` mailbox, and never implements. Sprints
run unattended end to end under `.claude/skills/sprint/references/run.md` — the
phase-scripted daemon-session pipeline, restored as the default 2026-08-24
(PR #3275). The lane/subagent model is retired; its durable lessons are folded
into run.md.

**Plan one sprint at a time.** No multi-sprint sequences — a sprint is planned at
its own boundary from the then-current board. (The old 79–83 waterfall here is
void.)

## The two MVPs (operator-approved 2026-08-24)

**MVP-1 COMPLETE 2026-08-28 — v2.0.0 SHIPPED. The release hold is discharged.**
Sprint 81 merged all ten remaining exit criteria (#3332 #3246 #3353 #3351 #3265 #3209
#3352 #3036 #3192 #3273) and cut **v2.0.0** at `184d1578`, tagged and published with all
four platform artifacts. First real run of the versioned-install machinery — it worked for
binaries but published an **empty release body** (#3409); notes were attached after the fact
with `gh release edit`. Release criterion verified: `git grep -w 'StateDb|stateDb'` on main
returns **0 files**; surviving `state.db` strings are the importer naming the legacy file it
migrates from, which ships in 2.0.0 as the upgrade path.

**Next release is 2.x from a clean main.** Prior guidance to never cut 1.14.x still holds —
it is now moot.

The v2.0.0 cut is sprint 81's wind-down deliverable and is *budgeted as scope*: ~15
sprints of changelog since v1.14.6 (2026-07-13), and the first real exercise of the
versioned-install machinery, which landed dormant and has never run.

1. **MVP-1 — ship v2.0.0, restore release cadence.** The state.db→mcx.db
   migration is FINISHED (audit 2026-08-24: mcx.db is the only runtime DB;
   state.db byte-frozen since the Aug 22 import seal; enforcement spec guards the
   legacy path). Remaining = verify/rename/delete. The original criteria list is
   superseded by the STATUS block above — do not work from it; sprints 80 and 81
   closed most of it. The importer SHIPS in 2.0.0 (it is the upgrade path);
   deletion is a later-2.x decision.
2. **MVP-2 — the operator loop, reconciler-first.** `mcx phase advance` is a
   correct single reconcile tick that nothing calls. Close the loop with: the
   daemon-side ticker #3274, the exception sink #3272, `phase.changed` emission
   from work-items-server, registering the `bind` automation module. The #3019
   cards/reducer stack (epics D+E) is the *successor* decision source, not a
   parallel build. Auto-merge stays opt-in and last (#1942 D6).

Epics C/F/G/H (trust, sensors, email, console) and I's tail serve neither MVP —
they wait until the loop demands them.

## Deployment state (2026-08-28 ~08:20 UTC)

- **v2.0.0 tagged at `184d1578` and published.** Main checkout is clean at that commit —
  the `-dirty` stamp cause below is resolved (the meta files that caused it now live on main).
  Local binaries still predate the tag: rebuild + reinstall + reload deliberately.
- **Earlier (2026-08-26): rebuilt, reinstalled, daemon reloaded at main HEAD `47bf951b`** (operator-authorised
  2026-08-26). Client/daemon protocol match restored — the pre-reload CLI errored
  `Protocol mismatch: daemon 5a109abfbc9d, CLI expects 87ce34d5a538`. Reload path used was
  `mcx daemon reload` (build `1.14.6+1787596440` → `1.14.6+1787758875`), **not** a kill.
  New surfaces live: `_work_items` 9→10 tools, `_metrics` 5→6. All seven phases `ok`.
- Binaries installed by **atomic copy** at `~/.local/bin` (per #3263 — never symlink;
  verified post-install with `test -L`). A `cp` over a running binary hits `ETXTBSY`, so
  the install is `cp` to a dotfile in the same dir then `mv` — rename replaces the
  directory entry while the running process keeps its inode.
- The build stamps `-dirty` because `.claude/boss/STATE.md` is uncommitted in the main
  checkout (it lives on `sprint-81`). Verified byte-identical to the sprint-81 commit —
  **no code drift**. The v2.0.0 cut must build from a clean tag.
- Five idle sprint-80 sessions byed (`dda7949a c30d7dd3 2db6ec57 52f3e673 d4931cb3`),
  all clean, all on already-merged branches. Worktrees preserved, not swept.
- `mcx domain add mcp-cli ~/github/mcp-cli` done — domain_id paths exercised for real;
  work items now carry the `d2:` prefix. The versioned-install machinery (`~/.mcp-cli/bin/`)
  is still dormant and has never run; first real use = the v2.0.0 release.
- Earlier (2026-08-24): claude patched copy at 2.1.241; #3234 idle-exit and #3227 quota
  fixes live — the systemd stopgap is obsolete (it caused #3243; never reinstall it).

### Worktree sweep at pre-flight (2026-08-26)

**27 worktrees → 1.** Only `sprint-81` remains (active, PR #3360). `mcx gc` reclaimed 15
and deleted 8 merged branches; 4 more needed `git worktree unlock` first (stale locks,
see #3363); the rest were removed by hand after verification. `mcx gc --dry-run` now
reports nothing to do.

Method, for the next sweep — **the authoritative supersession signal is PR merge state,
not a file diff.** Comparing a branch's files against main flags branches that main has
moved *past* as if they held unique work: `fix/issue-3213-adopt-or-ignore` showed 1
"differing" file, but its commit had merged as PR #3287 and main had since changed that
file again. Query `gh pr list --head <branch> --state all` instead. `mcx gc`'s own
judgement agreed exactly with the PR-state analysis on all 19 candidates.

Removing a worktree does **not** delete its branch, so committed work is never at risk —
only uncommitted work is. Three trees held uncommitted drafts, all verified superseded
(one stale TS7 attempt using the `typescript-native` naming CLAUDE.md now forbids; two
byte-identical drafts of the #3344 change that shipped differently as #3347). Snapshotted
to scratch before removal.

**Branches deliberately preserved** (unique commits, no PR, kept as refs after their
worktrees were reclaimed):
- `qa-3328` — content is on main via #3328's squash; kept only because commit identity differs.
- `fix/issue-3254-work-items-delete` — abandoned alternative to #3348. Main already has
  exact-id `work_items_delete` with the #3240 bare-number refusal; this branch's extra idea
  is aliasing `work_items_untrack` onto it and reporting the id actually deleted.
- `chore/3333-bun-140-pins` — abandoned alternative to #3346, touches `bun-version.ts`.
  **#3333 is still open**, so check this branch before re-implementing its tail.

Never `git worktree remove --force`: the safety check is load-bearing and in this sweep it
correctly refused two trees holding an untracked `pre-commit.spec.ts`.

### Sprint-80 debris cleared at pre-flight

Three work items were merged+closed but stranded at `phase: impl` with `prNumber: null`
— a reconciler tick (#3274) could have re-spawned impl on a closed issue. Repaired via
`work_items_update`: **d2:#3247→done/PR 3349, d2:#3254→done/PR 3348, d2:#3344→done/PR 3347**.
**d2:#3333 deliberately left at `impl`** — #3333 is genuinely still OPEN (PR #3346 said
`refs`, not `fixes`, and actually closed #2915; sprint 80's retro wrongly listed it as
delivered). Not an MVP-1 blocker; carry to sprint 82.

`mcx phase run <t> --no-execute --force` does **not** do this job — it prints
`approved [FORCED]: impl → done` and leaves the phase untouched (#3361). Use
`work_items_update` with `phase`/`force`/`forceReason`.

## Known traps (re-verified 2026-08-28)

- **An armed-but-silent waker is indistinguishable from a killed one.** Sprint 81 stalled
  ~17h because the orchestrator's monitor filter used
  `select((.ts|fromdateiso8601? // 0)*1000 >= $start)` — jq's `fromdateiso8601` cannot parse
  the fractional-second timestamps mcx emits, `?` swallowed the error, `// 0` made every
  comparison false. The process was healthy for 20.6h and wrote a **0-byte** output file.
  **The tell is output size.** Check it before concluding "nothing is happening". Do not put
  date arithmetic in a monitor filter.
- **The task supervisor can kill a background wrapper and orphan its children** (exit 144 =
  128+16). Both wakers died at once; `sleep` and `mcx monitor` kept running with nowhere to
  report. Filed #3396. Do NOT respond with a reaper — see the cpu-wedge memory / #2637.
- **Stale `session_id` blocks `mcx phase advance`** — seen at impl, repair, and qa across two
  sprints. The key is `session_id`, not `<phase>_session_id`. Worse: clearing it makes impl
  **re-spawn** on an issue whose PR is already open and green. Correct order is
  `work_items_update` to the target phase FIRST, then `phase advance`. Never clear the
  session id on a phase that actually completed.
- **`phase_state_delete` returns `deleted: false`** for a key that never existed rather than
  erroring — a wrong key name looks like a successful no-op.
- **`worktree_path` must be set before advancing to review/QA** (#3393), or the phase falls
  back to `--worktree` and reviews a fresh `main` checkout containing none of the diff.
- **The release workflow publishes an empty body** — an annotated tag's message is NOT used
  as the release notes (#3409). Attach them with `gh release edit --notes-file` after.

- **No GitHub merge queue on this plan.** Never propose one (or `strict: true`).
  #3259 was **closed not-planned 2026-08-26**: its part 4 (merge queue) is permanently
  unbuildable, and its premise — a herd of unleased full suites — was fixed at the root by
  #3344/PR #3347. Residual local-gate work lives in #3332, #2965, #3211, #3226, #3342.
  Explore `gh-stacks` instead — operator's own caveat: "even more coordination".
  See `.claude/memory/no_github_merge_queue.md`.
- **The gate baton is `gate-lease.ts`, not a protocol.** `am-i-done`'s `TEST_CHANGED`
  step is `lease: true` and every hook path reaches it. Do not hand out a baton;
  sprint 80 did, for a whole sprint, and it stranded a finished item.
- **Pre-commit is a static gate now** (~20.6s measured): `am-i-done --pre-commit`,
  no tests, no coverage (#3344/PR #3347, with a regression spec). The old direct
  `bun run test:coverage` bypassed the lease and *was* the gate-herd contention driver.
- **`core.hooksPath` is `.git-hooks` — RELATIVE**, resolved per working tree. Each
  worktree runs its own checked-out hook. Sprint 80's retro claimed the opposite;
  that action item was not filed because its premise is false.
- **Binaries do not auto-update.** `~/.local/bin/*` are atomic copies (#3263, never
  symlink). A `bun run build` does NOT update the `$PATH` binary or the running
  daemon — reinstall and restart deliberately.

## mcx-session hazards — all four CLEARED in sprint 80

#3013 (PR #3289), #3110 (PR #3308), #3140 (PR #3322), #3104 (PR #3295) all merged.
The rate-limit badge is now `[rate-limited 0:45 ago]`, not the old literal
`[RATE LIMITED]`, and it expires instead of latching for the turn.

Live successors worth knowing: **#3285** (spawn blocked by a stale claude patch even
when the session would use stdio), **#3296** (a third rate-limit latch path missed by
#3104/#3295), **#3291-#3294** (silent failure paths in claude re-probe / TLS setup),
**#3323** (SharedWorktreeGuard endedAt race in the ~7s kill-grace window).

## Standing operator grants and rules

- **No human gates mid-sprint** — approvals at planning; surprises spike to next
  planning; catastrophes spike the sprint (now also in plan.md).
- **Security fixes always in scope**; **two QoL fixes per sprint** max.
- **Merge policy — gated class**: no auto-merge; adversarial review + QA before
  merge for security, isolation/containment, auth, DB schema, spawn path.
  Decide at dispatch time. Gated raises rigor, not model tier.
- Model mix, gate baton, waiting discipline: run.md is canonical.
- Claude Code auto mode is good; do not "fix" containment by denying Bash.

## Coordination

Shared box with phoenix-octovalve (`phoenix-boss` via SendMessage / agent
message). The am-i-done gate lease is per-repo, not per-host — `uptime` is the
honest load signal. Never fix load with a killer/reaper/watchdog.
