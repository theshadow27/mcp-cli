# mcx-boss — live state

**Read this first after a compaction or a session restart.** Rewritten 2026-08-24
during the post-sprint-79 recovery re-plan. This is the durable record of
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

1. **MVP-1 — ship v2.0.0, restore release cadence.** The state.db→mcx.db
   migration is FINISHED (audit 2026-08-24: mcx.db is the only runtime DB;
   state.db byte-frozen since the Aug 22 import seal; enforcement spec guards the
   legacy path). Remaining = verify/rename/delete: epic-A exit (#3036 #3041
   #3042), integrity set (#3152 top ship-blocker, #3210 #3180 #3254 #3255 #3209
   #3213 #3246 #3247 #3192), the #3155 exit audit (now exercisable — mcp-cli is
   registered as a domain), naming cleanup #3273, release infra (#3264, #3231
   minimal, #3260 #3265). The importer SHIPS in 2.0.0 (it is the upgrade path);
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

## mcx-session hazards — fix early in sprint 80 or accept explicitly

#3013 (patch-gate strands spawns after every claude auto-update until daemon
restart — the most likely "mysteriously can't spawn"), #3110 (spawn reports
success for dead children), #3140 (worktree collision guard), #3104/#2918
(rate-limit events confound "is my worker done"; `mcx claude wait` returned 0 on
a spurious `session:rate_limited` before any result in the 08-24 probe).

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
