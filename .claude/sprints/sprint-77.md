# Sprint 77

> Planned 2026-07-13 (during sprint-76 wind-down, per plan.md Step 7). Target: 16 PRs (14 firm + 2 capacity-dependent).

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

## Context

Planned while sprint 76 winds down (6 idle sessions draining; per plan.md Step 7 no spawns until 76 closes). dist/mcx was stale vs origin/main at plan time — run-phase pre-flight must rebuild + restart the daemon before spawning. Scrutiny mix is heavier than the standard 60/25/15 (6 of 16 high) because throwback survivors are disproportionately the meaty ones; the two capacity-dependent picks (#1964, #1829) are the pressure valve. #935/#2659 also unblock Bedrock routing for future sprints — relevant while Anthropic extra-usage remains company-capped (sprint 76 stalled on quota 3×).
