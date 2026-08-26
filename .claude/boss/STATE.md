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

**MVP-1 STATUS 2026-08-26 — 10 exit criteria left, all scheduled into sprint 81
(plan: `.claude/sprints/sprint-81.md`, container PR #3360).** Remaining work items:
#3209 #3352 #3192 #3273 #3246 #3036 #3353 #3265 (+ two protect picks #3332 #3351).
Discharged at planning: #3041 closed as dup of #3192; #2993 and #3231(d) closed as
already-done (`release.yml` was pinned to Bun 1.4.0 by PR #3346, not just CI);
#3155 closed — the audit ran at planning time, on purpose, so its findings could not
re-block the release at wind-down. It found two cut-line defects, now scheduled:
**#3353** (a merge in one project advances another project's work item) and **#3352**
(events stamped with the daemon's domain, so `monitor -d` replays the wrong stream).
Five non-blocking gaps filed: #3354-#3358. **The storage layer audited clean** — both
defects are in the event/derived-rules path, not the DB.

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

## Deployment state (2026-08-24 ~18:35 UTC)

- Daemon rebuilt + restarted at main HEAD `90669cb4`; client/daemon protocol
  match; claude patched copy updated to 2.1.241; default-path spawn verified
  end-to-end. The #3234 idle-exit fix and #3227 quota fix are live — the
  systemd stopgap is obsolete (and caused #3243; never reinstall it).
- `mcx domain add mcp-cli ~/github/mcp-cli` done — domain_id paths
  now exercised for real (feeds #3155).
- Binaries installed by atomic copy at `~/.local/bin` (per #3263 — never
  symlink them back). The versioned-install machinery (`~/.mcp-cli/bin/`)
  landed dormant and has never run; first real use = the v2.0.0 release.

## Known traps (re-verified 2026-08-26)

- **No GitHub merge queue on this plan.** Never propose one (or `strict: true`).
  #3259's part 4 is unbuildable as written. Explore `gh-stacks` instead — operator's
  own caveat: "even more coordination". See `.claude/memory/no_github_merge_queue.md`.
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
