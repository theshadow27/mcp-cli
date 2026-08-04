# Sprint 77

> Planned 2026-07-13 (during sprint-76 wind-down, per plan.md Step 7). Target: 16 PRs (14 firm + 2 capacity-dependent).
> Started 2026-08-03. Container PR #2923.

## Goal

Throwback: clear the surviving pre-#2000 gems — Bedrock spawn profiles, transition-log durability, and monitor ergonomics — plus a slate of aged, verified-live fillers.

## Issues

| # | Title | Scrutiny | Batch | Model | Provider | Category |
|---|-------|----------|-------|-------|----------|----------|
| 2659 | pass model tier names verbatim — remove MODEL_SHORTNAMES ID pre-resolution | medium | 1 | opus | claude | goal |
| 1328 | transition log → bun:sqlite migration (subsumes #1372 NFS-lock + #1375 streaming/rotation — one worker, PR closes all three) | high | 1 | opus | claude | goal |
| 1924 | monitor: unify event envelope — producer summary + severity | high | 1 | opus | claude | goal |
| 1590 | daemon: per-server rate limit for tool calls (Atlassian 429s) | medium | 1 | opus | claude | goal |
| 1702 | permissions: reject combined tool-wildcard + arg-pattern rules (Option 1 only) | low | 1 | opus | claude | filler |
| 935 | spawn profiles: `--profile` + `~/.mcp-cli/profiles/` + `defaultProfile` (Bedrock quota relief) | high | 2 | opus | claude | goal |
| 1459 | sites: 500 → wiggle + retry (mirror the 401 path) | low | 2 | opus | claude | filler |
| 1831 | tls: defense-in-depth validation for cached cert/key | low | 2 | opus | claude | filler |
| 1540 | sites/owa: capture BaseFolderId + PUID from live session | medium | 2 | opus | claude | filler |
| 1750 | mcx claude bye: flip default to keep; --clean to remove (re-read #1748/#1749 closing PRs when scoping) | medium | 2 | opus | claude | filler |
| 1245 | vfs: adaptive batch-size tuning for clone (429 backoff) | medium | 2 | opus | claude | filler |
| 1939 | monitor: notification-cadence layer — coalesce window, heartbeat-on-quiet | high | 3 | opus | claude | goal |
| 1249 | vfs: progress reporting for large clone/pull | low | 3 | opus | claude | filler |
| 1510 | orchestrator: scoped GH_TOKEN per worker | medium | 3 | opus | claude | filler |
| 1964 | daemon cache backend for ctx.gh (capacity-dependent — drop first if hot) | high | 3 | opus | claude | goal |
| 1829 | daemon POST: NODE_USE_SYSTEM_CA over NODE_TLS_REJECT_UNAUTHORIZED (capacity-dependent — drop second) | high | 3 | opus | claude | filler |

## Batch Plan

### Batch 1 (immediate)
#2659, #1328, #1924, #1590, #1702

### Batch 2 (backfill)
#935, #1459, #1831, #1540, #1750, #1245

### Batch 3 (backfill)
#1939, #1249, #1510, #1964, #1829

### Dependency edges (translate to `addBlockedBy` at run time)
- #935 blockedBy #2659 (both edit `packages/core/src/model.ts`, `packages/command/src/commands/spawn-args.ts`, `packages/daemon/src/claude-session-worker.ts`; verbatim tier passthrough is also what makes profiles' Bedrock aliases work)
- #1939 blockedBy #1924 (both edit `packages/core/src/monitor-event.ts` + `packages/daemon/src/event-bus.ts`; cadence's severity-sort consumes the envelope's severity tag)
- #1510 blockedBy #935 (both restructure the `envOverrides` block in `packages/daemon/src/claude-session/ws-server.ts:938-961`)
- #1829 blockedBy #1510 (same envOverrides block — third in the chain)
- #1249 blockedBy #1245 (both edit `clone/providers/confluence.ts` + `packages/command/src/commands/vfs.ts`)

### Hot-shared file watch
- `packages/daemon/src/claude-session/ws-server.ts` — envOverrides chain #935 → #1510 → #1829 (serialized via edges). #1831 touches the same file at a different region (SDK URL ~:703) — when the first env-chain PR merges, broadcast a rebase directive to #1831's session.
- `packages/core/src/phase-transition.ts` — #1328 only (single consolidated worker; #1372/#1375 must NOT be spawned separately).
- `packages/core/src/model.ts` / `spawn-args.ts` / `claude-session-worker.ts` — #2659 → #935 (serialized via edge).
- `packages/core/src/monitor-event.ts` + `packages/daemon/src/event-bus.ts` — #1924 → #1939 (serialized via edge).
- `clone/providers/confluence.ts` + `commands/vfs.ts` — #1245 → #1249 (serialized via edge).
- No dispatch-table (main.ts) collisions predicted: new subcommands land only in #1829 (`mcx install ca-cert`) and possibly #1540 (`mcx site capture`) — different dispatch files (`install.ts` vs `site.ts`); flag a rebase check if both add to `main.ts` routing.

### Pre-session clarifications required
- **#1328**: worker brief must state the rescope explicitly — migrate `.mcx/transitions.jsonl` to `bun:sqlite` (races, NFS, unbounded memory all die together); PR closes #1328 + #1372 + #1375. Migration path for existing jsonl files required. High scrutiny → adversarial + QA.
- **#935**: precedence order pinned in issue comments — `--profile` flag > repo `.mcx.yaml` > `defaultProfile` config > bare daemon env. Secrets live in profile files, never in SQLite or logs. High scrutiny → adversarial + QA.
- **#1750**: design questions in body were contingent on how #1748/#1749 landed — worker must re-read both closing PRs before implementing.
- **#1702**: Option 1 (parse-time reject with clear error) ONLY — Option 2 (JSON-path matching) explicitly out of scope.
- **#1964**: largest item (~400-600 LOC). Capacity-dependent: skip if the sprint runs hot; it keeps.

## Excluded (and why)
- #1372, #1375 — subsumed into #1328's SQLite worker (see above).
- #1508 — closed-as-done at plan time (ci.yml classifier gate already implements it; verified).
- #207, #1404 — labeled needs-clarification at plan time with evidence comments (flags already exist / repro predates .mcx.yaml migration).
- #1639 — Bun-upstream stream-cancel limitation, testing-only; recommend close-as-wontfix (user call).
- #1602 — author-marked aspirational, large build-system redesign; not throwback material.
- #698, #699 — needs-clarification, big scope.
- #1177, #1209, #1486, #1611, #1942 — epics/arcs, not picks.
- #1250 — surface is sprint wind-down logic (meta, run.md); orchestrator-owned, excluded per rule 5.
- #1251 — needs human PostHog account setup.
- #1392 — codex respawn race; codex provider currently broken (#2482), no point hardening it first.
- #1397 — merge-queue service; belongs to the sprint-operator arc (#2577/#1942) with its own design pass, and its surface includes `.claude/skills/` (mergemaster).
- #1453, #1970 — spikes, not implementable picks.

## Run-phase findings (orchestrator, 2026-08-03)

- **Stale model map was live-degrading every worker.** `MODEL_SHORTNAMES.opus` resolved to
  `claude-opus-4-8` while Opus 5 was current, so `--model opus` silently span workers a tier
  behind — every sprint since the Opus 5 release. First 8 sessions came up on 4.8; killed and
  respawned on the full ID `claude-opus-5` (pass-through branch bypasses the map). All
  phase-script spawns (`impl.ts` opus, `qa.ts` sonnet) hit the same bug, so the orchestrator
  overrode every spawn to full IDs for the remainder of the sprint. Evidence posted to #2659.
- **#1702 was mis-sized by the plan.** Scheduled as a low-scrutiny filler; triage escalated it
  to high (6 files / 5 packages) because the validation change fans out across the acp, codex,
  opencode and daemon permission adapters. Plan's scrutiny column was wrong; triage's
  file-fan-out heuristic caught it.
- **Host CPU contention, not API quota, was the throughput bottleneck.** With 12 concurrent
  sessions on a 16-core host, simultaneous `am-i-done` runs pushed load average to ~19 and
  produced spurious mass failures (112 failures + worker SIGTERMs at ~6s on #2659; #1924 hit
  the same and self-throttled). Same trees passed clean on CI runners. Matches the known
  `false-segfault-orphaned-load` signature. Orchestrator capped concurrency rather than
  spawning further. New issue filed proposing admission control for `am-i-done` (NOT a
  killer/reaper — see #2637 / the sprint 69-70 collapse).
- **#1459 ships dormant.** `loadCatalog` seeds `catalog.json` only when absent and never
  reconciles, so the new `retryOn` field reaches no existing installation (#2926, filed by the
  worker). Deliberately NOT expanded mid-sprint; PR body required to state the limitation
  rather than imply the 500-retry problem is solved.

### Mid-sprint amendment: +#2690 (added 2026-08-03, run phase)

**#2690 — concurrent `am-i-done` runs oversubscribe host → mass SIGTERM storm.** Added to
scope at user request after the problem stalled two workers in this sprint. Open, unassigned,
labeled bug/testing/ci, with 5 prior data-point comments spanning multiple sprints (including
sprint 76, where workers independently invented ad-hoc load-gating). The fix is already
specified on the issue: flock-based admission control.

Amendment gate (#2768) — hot-file overlap check run before launch. Predicted surface is
`scripts/` (am-i-done runner) + `packages/core/src/flock.ts`. Diffed against every batched and
in-flight issue: #2659 (core/model, command, daemon session-worker), #1702 (permissions +
provider adapters), #1459/#1540 (daemon/site), #1328 (core/phase-transition), #1924
(core/monitor-event + daemon/event-bus), #1590 (daemon), #1750 (command/claude +
worktree-commands), #1245 (clone/confluence + command/vfs). **No overlap → no `blockedBy`
edge.** Caveat passed to the worker: #1328 is concurrently removing the transition log's
lockfile usage, so #2690 must *consume* `flock.ts` without reshaping its API.

Hard constraint restated for the worker: admission control / queueing on entry ONLY. No
killer, reaper, orphan-sweep, watchdog, or host-wide `ps`-and-kill — that approach caused the
sprint 69-70 collapse and was reverted in #2637.

Interim stopgap in force for the rest of this sprint: orchestrator broadcast a `mkdir`-based
host-wide lock directive to all sessions, serializing the gate to one run at a time. Load
average fell 27 → 14 within minutes of the broadcast.

### SPAWN FREEZE — 2026-08-03 13:52Z (09:52 EDT), operator-ordered

Usage critical. **No new spawns of any kind (impl / review / QA / repair) until 14:00 EDT
(18:00Z).** Five-hour window resets 18:20Z. In-flight sessions run to completion — already-paid
work; killing them would waste the spend without recovering quota. Only zero-LLM actions
continue: merges of PRs that already hold their verdicts, label flips, CI reruns, triage
(script, not an LLM call), and bookkeeping.

**The usage meter was not the signal — the operator was.** `_metrics quota_status` reported
`fiveHour.utilization: 8` / `sevenDay: 3` while usage was in fact critical, because the
upstream quota endpoint was itself returning 429 and the daemon served cached figures with
`available: true` and no staleness marker. The orchestrator read `8%` as authoritative and
told the operator "quota is fine" three times while continuing to spawn. Contradicting
evidence was visible and under-weighted: every session showed `[RATE LIMITED]` in
`mcx claude ls`, and `lastError` held the 429. Bug filed. Until it is fixed, the operative
rule is **`lastError != null` invalidates the utilization reading — fail safe (freeze), not
open (spawn)**, and a fleet-wide `[RATE LIMITED]` overrides a low utilization number.

**Queued at freeze time (act in this order on resume, 14:00 EDT):**
1. `#1540` — **self-repair + rebase in one pass** (PR 2934). Review found an empirical blocker:
   `inboxFolderId` captures **Sent Items**, not the inbox, and persists it. Systematic, not
   chance — OWA sends `DistinguishedFolderId:inbox` for the inbox, so the seed's
   `select(.__type != "DistinguishedFolderId")` filters *to* non-inbox folders; every
   concrete-id `FindConversation` request in the validation sample confirms. Capture reports
   `missing: []` while `mcx site call owa inbox` silently returns the wrong folder. Reviewer
   already located a verified replacement spec from `GetOwaUserConfiguration`'s authoritative
   name→id table. Second blocker: vars are sticky with no invalidation (`{...loadVars(), ...vars}`
   only adds; no `--clear`), so the wrong value is unremovable without hand-editing JSON.
   PR went `DIRTY` when #1459 merged — the predicted `daemon/site/` hot-file collision, arriving
   via merge order rather than the serialization edge. Rebase and repair together, not piecemeal.
2. `#1924` — self-repair (PR 2931). All three documented envelope invariants are violable;
   `enrichMonitorEvent` (`monitor-event.ts:630-640`) never strips `payload` and never validates
   `severity`. Note #1939 is blocked on this and consumes the severity tag, so the invariant has
   to actually hold before #1939 can be launched.
3. `#1590` → review (high; 286 churn, 7 files, command+core+daemon) — PR 2941
4. `#1750` → QA (low; 27 churn) — PR 2942
5. `#1702` → QA (PR 2927, CI green). Carries `review:changes` from its own self-repair; the
   verifying QA session owns the label swap. **Must not merge carrying `review:changes`.**

Self-repairs above go to the session that wrote the review (context still loaded, sessions
persist across the freeze) — but none of them may approve their own repair. A fresh QA session
owns every pass/fail.

**Running at freeze time (do not respawn):** `#2659` QA (PR 2929, `review:pass`, CLEAN),
`#1540` review (PR 2934), `#1924` review (PR 2931), `#1459` QA (PR 2930), `#1702` reviewer
self-repair (PR 2927), `#1328` impl, `#1245` impl, `#2690` impl.

**Never launched, and must not be during the freeze:** `#935` (blocked on #2659 merge),
`#1939` (blocked on #1924), `#1510` (blocked on #935), `#1829` (blocked on #1510), `#1249`
(blocked on #1245), `#1964` (parked capacity valve). Given the freeze plus the CPU ceiling,
`#1964` should be formally dropped at wind-down rather than launched late — it is the
designated pressure valve and it keeps.

### THE finding of sprint 77: tests that cannot express the failure

Five of six adversarial reviews found code that passed a **green `am-i-done` and green CI**
while being functionally broken. Every reviewer caught it the same way — by *running* the
code at production settings and observing the result — and no test could have caught any of
them, because in each case the test and the code encode the same assumption.

| PR | What the test did | What shipped |
|---|---|---|
| #1702 | Asserted a rule was dead, per the code's own rationale | Hard-failed a **working** deny rule |
| #1540 | Real-jq fixture authored from the code's hypothesis; asserted *a* concrete id was extracted | Captured **Sent Items** as the inbox |
| #1245 | Pinned `retry: { maxRetries: 0 }` — a config **no caller produces** | Adaptation inert; `[250,250,250,250,250]` then abort |
| #2690 | Pinned `slots: 1`, never exercising the default `K=2` | Docstring asserted an invariant the code lacked |
| #1590 | Injected an **exact-advance** virtual clock (`now += ms`) | Timer *overshoot* is unrepresentable → post-deadline dispatch invisible |

**Two distinct species, and the second is worse:**

1. **Config-pinning** — the test exercises a configuration no caller produces. Mechanically
   detectable: flag a spec that only ever exercises an option with an explicit non-default
   value. Candidate `doing-it-wrong` rule.
2. **Harness-blindness** — the test *scaffolding* cannot represent the failure mode at all.
   #1590's clock advances exactly, so "fires at-or-after" never happens; #1540's mock ignored
   `limit`, so it could not prove the cursor property it asserted. **Not** mechanically
   detectable, and immune to more tests written on the same harness. A green suite here is
   not weak evidence — it is *no* evidence, and it actively reads as assurance.

Corollary that changed orchestrator behaviour mid-sprint: **CI green is not evidence against
a blocker whose failure mode the harness cannot express.** #1590 was green on all five checks
in both rounds while carrying a reproducible duplicate-external-write bug.

Related: `Math.max(deadline - now, 1)` — a floor that *looks* defensive and does the exact
opposite, converting "no budget left" into "dispatch anyway". #2955 filed for the clamp-invariant
rule; the reviewer notes the class is silent **and** inverted, so unreachable by type checking.

**Retro proposals (meta-surface — orchestrator/retro-owned, cannot go to a worker mid-sprint):**
1. **Impl brief**: bar for done becomes "demonstrate behaviour at the DEFAULT configuration
   with observed numbers, not asserted intent." Zero marginal sessions. Improvised in this
   sprint's repair briefs and it worked — #1245 came back with
   `expect(observedLimits).toEqual([250,125,62,31,25])` and a spec comment reading
   *"Do not add `maxRetries: 0` to these tests. That configuration has no caller."*
2. **Review brief**: add an explicit checklist item — *for every test that passes a config
   override, is the default also covered? Can this harness represent the failure at all?*
3. **Rule** (`rule-author`): mechanize species 1 only. Species 2 is a judgement call and
   belongs to review, permanently.

**Rejected: a dedicated adversarial-test-writer phase.** It would duplicate the review phase,
which caught 5/5 of these, at ~16 extra sessions per sprint — and a test adversary working
from the issue text can encode the same wrong assumption an implementer does. Revisit only if
the impl-brief change ships and the class still appears at this rate next sprint.

### Amendments to Excluded
- **#207 — exclusion reasoning was wrong; promote next sprint.** Excluded at plan time as
  "flags already exist". Half-right: `--full` exists and works, but `mcx claude log --json`
  emits invalid JSON (unterminated string, `JSONDecodeError` at char 68524), so there is no
  reliable machine-readable way to read a worker's full result. Hard repro posted to #207;
  `needs-clarification` should come off.
- **#2926 (new, filed by #1459's worker) — seed reconciliation.** Blocks #1459 from reaching
  users. Needs its own design pass on customization-vs-upstream merge. Next-sprint candidate;
  would be `blockedBy` #1459 on file overlap (`packages/daemon/src/site/`).
- **#2928 (new) — ~48 stale worktrees** never reclaimed by `mcx gc`, spanning ~30 sprints.
  Also pollutes repo-wide greps (a 3-file search returned 125KB across duplicate checkouts).
  Interacts with #1750, which flips `bye` to keep-by-default and will accelerate accumulation.

### Orchestrator follow-up owed at retro
- `.claude/memory/project_bedrock_spawns_935.md:14` documents the `resolveModelName` caveat
  removed by #2659. Meta-file, orchestrator-owned — update at retro, not by a worker.

## Context

Planned while sprint 76 winds down (6 idle sessions draining; per plan.md Step 7 no spawns until 76 closes). dist/mcx was stale vs origin/main at plan time — run-phase pre-flight must rebuild + restart the daemon before spawning. Scrutiny mix is heavier than the standard 60/25/15 (6 of 16 high) because throwback survivors are disproportionately the meaty ones; the two capacity-dependent picks (#1964, #1829) are the pressure valve. #935/#2659 also unblock Bedrock routing for future sprints — relevant while Anthropic extra-usage remains company-capped (sprint 76 stalled on quota 3×).
