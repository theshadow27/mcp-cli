# Sprint 10

> Planned 2026-03-11. Target: 15 PRs.

## Goal

Clear Control TUI follow-ups + daemon hardening + test/tooling debt

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 638 | stale expandedEntries indices | low | 1 | opus | goal |
| 639 | transcript polling off-tab | low | 1 | opus | goal |
| 640 | pager temp file cleanup | low | 1 | opus | goal |
| 641 | viewport scroll for transcripts | low | 1 | opus | goal |
| 647 | release.ts automation | low | 1 | opus | goal |
| 642 | SIGTERM escalation fix | medium | 2 | opus | goal |
| 496 | MCP handshake timeout test | low | 2 | opus | filler |
| 409 | mcx auth --help + login flow | medium | 2 | opus | filler |
| 466 | test-failure-log hardening | low | 2 | opus | filler |
| 385 | README missing commands | low | 2 | sonnet | filler |
| 140 | mcpctl mail viewer TUI | medium | 3 | opus | goal |
| 126 | command handler test coverage | low | 3 | opus | filler |
| 361 | pollUntil async predicates | low | 3 | opus | filler |
| 129 | Python-repr JSON parser | low | 3 | opus | filler |
| 290 | _metrics virtual MCP server | medium | 3 | opus | filler |

## Batch Plan

### Batch 1 (immediate)
#638, #639, #640, #641, #647

### Batch 2 (backfill)
#642, #496, #409, #466, #385

### Batch 3 (backfill)
#140, #126, #361, #129, #290

## Context

Sprint 9 (evening) shipped session persistence, Control TUI overhaul (6 PRs),
and v0.3.0. The TUI follow-ups (#638-641) are direct findings from adversarial
review of #443. Daemon hardening (#642) fixes a blocker found in review of #632.
Rest is tech debt and tooling that's been accumulating.

## Results

- **Released**: v0.4.0
- **PRs merged**: 11 (#648, #649, #650, #651, #655, #656, #657, #659, #660, #661, #662)
- **Issues closed (already fixed)**: 4 (#638, #642, #496, #385)
- **Issues closed (new PRs)**: 11 (#639, #640, #641, #647, #409, #466, #126, #361, #129, #140, #290)
- **Issues dropped**: 0
- **New issues filed**: 8 (#652, #653, #654, #664, #666, #670, #671 + follow-ups from reviews)
- **100% completion rate** — all 15 planned issues resolved

### Pipeline stats
- 4 issues required no code (already fixed in prior sprints)
- 5 PRs went through adversarial review + repair (high scrutiny)
- 2 PRs needed 2 rounds of review + repair (#409, #129)
- First sprint using the 4-phase skill (plan/run/review/retro)
