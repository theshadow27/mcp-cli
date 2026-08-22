# Sprint 78

> Planned 2026-08-22. Started 2026-08-22T05:28Z. Target: 17 PRs (15 firm + 2 capacity-dependent).
> First sprint of the #3019 arc — domain-scoped mcx.

## Goal

Land **epic A** — domains as the partition key every other table hangs off — and stand up the **domain worker** that epic B needs, so the rest of #3019 has a foundation to build on.

## Context

#3019 decomposes into ten sub-epics (#3021–#3030) with `blocked_by` edges wired to match the design. **A blocks every one of them**, so until the `domains` table exists and the daemon's tables are partitioned by it, nothing else in the arc can start. That makes this sprint unusually serialized at the root: #3034 is the single unblocked goal issue, and eleven others open up the moment it merges.

Design docs are on `main` as of #3020: [`domain-scoped-mcx.md`](https://github.com/theshadow27/mcp-cli/blob/main/docs/domain-scoped-mcx.md), [`domains.md`](https://github.com/theshadow27/mcp-cli/blob/main/docs/domains.md), [`cards.md`](https://github.com/theshadow27/mcp-cli/blob/main/docs/cards.md), [`sensors.md`](https://github.com/theshadow27/mcp-cli/blob/main/docs/sensors.md), [`trust.md`](https://github.com/theshadow27/mcp-cli/blob/main/docs/trust.md), [`console.md`](https://github.com/theshadow27/mcp-cli/blob/main/docs/console.md). **Every worker brief in this sprint must point at the relevant doc** — the issue bodies restate the load-bearing constraints, but the docs carry the reasoning, and this arc has more "why it is this way" than usual.

Batch 1's fillers are aged, verified-live issues that sprint 77 planned and never started (it froze on quota at 13:52Z and stopped). They are reused here rather than re-triaged. **#935 (spawn profiles / Bedrock) is deliberately promoted into batch 1** — sprint 77 died on quota exhaustion, this arc is six sprints long, and the escape hatch is worth landing before the arc needs it.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 3034 | the new database — `mcx.db`, `domains` table, `domain_id` partitioning, one-shot import | high | 1 | opus | goal |
| 935 | spawn profiles: `--profile` + `~/.mcp-cli/profiles/` + `defaultProfile` (Bedrock quota relief) | high | 1 | opus | filler |
| 1459 | sites: 500 → wiggle + retry (mirror the 401 path) | low | 1 | opus | filler |
| 1249 | vfs: progress reporting for large clone/pull | low | 1 | opus | filler |
| 1510 | orchestrator: scoped GH_TOKEN per worker | medium | 1 | opus | filler |
| 3035 | `mcx domain add\|ls\|show\|which\|rename\|rm` | medium | 2 | opus | goal |
| 3037 | scope `work_items` + `_work_items` server by domain | medium | 2 | opus | goal |
| 3038 | scope mail by domain; `user@domain` addressing | medium | 2 | opus | goal |
| 3039 | scope `agent_sessions` by domain; retire `scopeRoot` | medium | 2 | opus | goal |
| 3040 | scope `alias_state`, event log, automation state by domain | medium | 2 | opus | goal |
| 3043 | domain worker — one per domain, supervised, transport-agnostic | high | 2 | opus | goal |
| 3036 | `-d <domain>` resolution across the CLI | medium | 3 | opus | goal |
| 3041 | per-domain `AutomationDispatcher` — kill the `process.cwd()` singleton | medium | 3 | opus | goal |
| 3042 | retire `mcx scope`, superseded by `mcx domain` | low | 3 | opus | goal |
| 3045 | blast-radius test + `doing-it-wrong` rule: a domain worker serves no HTTP | medium | 3 | opus | goal |
| 3044 | run project code in the domain worker, not in `mcpd` (capacity-dependent — drop first) | high | 3 | opus | goal |
| 1829 | daemon POST: `NODE_USE_SYSTEM_CA` over `NODE_TLS_REJECT_UNAUTHORIZED` (capacity-dependent — drop second) | medium | 3 | opus | filler |

## Batch Plan

### Batch 1 (immediate)
#3034, #935, #1459, #1249, #1510

### Batch 2 (backfill — all open when #3034 merges)
#3035, #3037, #3038, #3039, #3040, #3043

### Batch 3 (backfill)
#3036, #3041, #3042, #3045, #3044, #1829

### Dependency edges

All of these are already wired as GitHub `blocked_by` edges on the issues themselves — translate them to `addBlockedBy` at run time rather than re-deriving.

- #3035, #3037, #3038, #3039, #3040, #3043 all blockedBy **#3034** (the schema must exist)
- #3036 blockedBy #3034, #3035 (`main.ts` dispatch — domain verbs land before the global flag)
- #3041 blockedBy #3034, #3040 (storage before the dispatcher object)
- #3042 blockedBy #3035, #3036, #3039 (`main.ts` again, third in the chain; needs the replacement working first)
- #3044 blockedBy #3043, #3041
- #3045 blockedBy #3043
- #3039 blockedBy **#935** (both edit `packages/daemon/src/claude-session-worker.ts`)
- #1829 blockedBy **#1510** (both restructure the `envOverrides` block in `ws-server.ts:938-961`)

### Hot-shared file watch

- **`packages/daemon/src/db/state.ts`** — #3034 **only**. This is the sprint's serialization root: every `domain_id` column and every per-domain uniqueness constraint is written once, by one worker, in one PR. No other session in this sprint may add a column here. If a batch-2 or batch-3 worker finds it needs a schema change, that is a signal to stop and report, not to edit the file.
- **`packages/command/src/main.ts`** — dispatch-table collisions. #3035 adds `case "domain"`, #3036 adds the global `-d` flag, #3042 removes `case "scope"`. Serialized #3035 → #3036 → #3042 via edges. Git will merge these without conflict and produce a broken table, so when each merges, broadcast a rebase-and-check-for-duplicate-dispatch-entries directive to the next.
- **`packages/daemon/src/claude-session-worker.ts`** — #935 → #3039 (serialized).
- **`packages/daemon/src/claude-session/ws-server.ts`** — #1510 → #1829 (serialized).
- **`packages/core/src/constants.ts`** — #3034 (`DB_PATH`) and #3042 (`SCOPES_DIR` removal). Different constants, far apart, but flag a rebase check on #3042.
- **`packages/daemon/src/automation-dispatcher.ts`** — #3040 (storage) → #3041 (object) → #3044 (relocation). Serialized via edges.

### Pre-session clarifications required

- **#3034**: the DB filename is pinned to `~/.mcp-cli/mcx.db`; `state.db` is left on disk untouched. The import marker is written into the **legacy** `state.db` so the import cannot re-run even if `mcx.db` is deleted; `mcx domain import --force` is the deliberate re-run. **No rollback, no dual-write, no swap protocol, and no tests around roll-forward or rollback** — the brief must say this explicitly, because the instinct of any competent implementer handed a schema change is to build migration machinery, and that instinct is wrong here. High scrutiny → adversarial + QA.
- **#3043**: the worker is addressed by `onmessage`/`sendMessage` today and becomes a **websocket port** when a domain moves hosts. Nothing in its interface may assume in-process delivery. The brief must name `site-worker.ts` / `site-server.ts` as the pattern to follow. High scrutiny → adversarial + QA.
- **#935**: precedence order pinned in the issue comments — `--profile` flag > repo `.mcx.yaml` > `defaultProfile` config > bare daemon env. Secrets live in profile files, never in SQLite or logs. High scrutiny → adversarial + QA.
- **#3042**: destructive by design — `scope.ts` and `SCOPES_DIR` are deleted, not deprecated in place. The worker must not leave a working fallback "just in case"; a second registry that still resolves is a second registry something will keep using.

## Results

- **Released**: none (halted mid-run by operator, ~22:15Z at 82% weekly quota)
- **PRs merged**: 6 of 17 issues — #1459, #1510, #935, **#3034** (the epic-A foundation, PR #3143), #1249, #3040 (PR #3169, auto-merge fired at 22:12)
- **Open with work pushed**: #3035/PR#3160, #3037/PR#3175, #3038/PR#3200, #3039/PR#3168, #3043/PR#3181, plus #3119/PR#3137 — dispositions in `sprint-78-disposition.md`, re-sequenced into sprint 79
- **Issues dropped**: the unstarted tail (#3036, #3041, #3042, #3044, #3045) — dependents of unmerged work; re-planned for sprint 79 under the foundation-first rule
- **New issues filed**: ~31 arc defect reports (#3134–#3218 range) + incidentals; 1 closed as duplicate (#3164 → #3170)
- **Container PR**: #3046 closed unmerged; sprint-meta landed via `meta/sprint-78-closeout` instead
- **Process outcome**: postmortem + process reset merged as PR #3219 (lanes execution model, review merge-risk bar, caps binding hand-orchestration, QA guard-mutation check)
