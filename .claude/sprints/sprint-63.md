# Sprint 63

> Planned 2026-05-24 13:05 EDT. Target: clear the rules backlog (stretch — ~34 issues).
> **Rollover condition: wall-clock 15:00 ET (~1h57m budget). See how far it gets; partial is expected and fine.**

## Goal

Wrap up the entire `doing-it-wrong` / `am-i-done` rules long-tail: stabilize the engine,
fix false-positives, burn down the ~333 suppressed/violating sites, finish the ROADMAP
phases, and land the 8 outstanding new feature-rules — emptying the rules backlog.

## Execution model

- **One large sprint**, run to the 15:00 ET clock. Prioritize Tier 1 → burndowns → fixes → new rules → infra.
- **Burndowns fan out internally.** Each big-burndown impl session is told to use its OWN
  Agent-tool subagents, one per file (or small file group), to avoid intra-session edit
  conflicts, then run the full `bun run am-i-done` once at the end. Native Agent tool is
  acceptable for these mechanical migrations.
- **Rule-PR discipline (mandatory):** any work item that ADDS detection must, in the same PR,
  add-rule/extend → show-red → remediate all surfaced violations → green gate. Never merge a
  rule the gate doesn't sweep. Verify clean via exit code, not a grep of output.
- **Always run the full `bun run am-i-done`**, never a subset. Worktrees: set
  `git config core.hooksPath .git-hooks` after creation (hooksPath inheritance bug).
- **Meta excluded** (#2350, #2333, #2343, and #2337's /rule-author skill-doc reconcile) →
  deferred to retro, unless directly required to unblock a burndown.

## Issues (grouped into work items)

Same-file overlaps are bundled into one PR (one session closes multiple issues).

| WI | Issues closed | Title | Scrutiny | Tier | Files / overlap | Notes |
|----|---------------|-------|----------|------|-----------------|-------|
| A | 2285,2286,2287,2288,2290 | rule-loader hardening (recurse glob, .tsx, validateRule via zod, resolve(), freeze) | high | 1 | `_engine/rule-loader.ts` | foundational; all 5 same file |
| B | 2300,2301 | ast helper hardening (element-access callsTo, drop parseDiagnostics) | med | 1 | `_engine/ast.ts(.spec)` | |
| C | 2292,2293 | poll-until-headroom rule FN+FP (inline comment, commented-out calls) | med | 1 | `poll-until-headroom.rule.ts` | **blocks D** |
| F | 2332 | parseFlags-compat snapshot suite | med | 1 | new test | **blocks E** |
| T | 2289 | doing-it-wrong --rule unknown-id reports "0 rules" | low | 1 | `doing-it-wrong.ts` | quick |
| Z | 2340,2341 + #2264×3 + Copilot-2 | no-error-msg-sniffing doc/comment + reconcile 3 orphaned #2264 + graphql exitCode msg + spawnCaptureSync input test | low | 1 | rule file + 3 src + graphql-client | reconcile orphans |
| D | 2291 (+2248) | **BURNDOWN** ~136 poll-until violations → explicit timeouts | med | 2 | test files (fanout) | blockedBy C |
| E | 2283 | **BURNDOWN** 94 manual arg-parse → parseFlags() | med | 2 | `command/src/commands/*` (fanout) | blockedBy F; hot: main dispatch |
| G | 2322 | **BURNDOWN** 78 test-empty-catch | low | 2 | `*.spec.ts` (fanout) | |
| H | 2323 | **BURNDOWN** 25 complex timers → safeSetTimeout/Interval | med | 2 | daemon files (fanout) | |
| I | 2319,2320 | no-hardcoded-test-port: drop 'connect', guard missing parent | med | 3 | `no-hardcoded-test-port.rule.ts` | same rule |
| J | 2335 | test-unguarded-narrowing: catch toStrictEqual discriminant | med | 3 | rule + remediate | adds detection |
| K | 2336 | test-filtered-assertion: multi-line Prettier-wrapped chains | med | 3 | rule + remediate | adds detection |
| L | 2284 | spawn-mock-kill FP from cross-object line-window | med | 3 | `spawn-mock-kill-*.rule.ts` | |
| M | 2314,2327 | cli-surface-registered: bidirectional + flag↔KNOWN_FLAGS | high | 3 | `cli-surface-registered.rule.ts` | same rule; adds detection |
| Q | 2321 | no-raw-path-handling: variable-bound process.cwd() compares | med | 3 | `no-raw-path-handling.rule.ts` | adds detection |
| R | 2342 | check-tool-result-iserror: destructuring + inline-chain | med | 3 | `check-tool-result-iserror.rule.ts` | adds detection |
| S | 2337 | appliesToTests engine fix (make it scope, not no-op) | med | 3 | `_engine/rule.ts` + test rules | skill-doc → retro |
| N | 2261 | NEW RULE derive-union-from-const | high | 4 | new rule + remediate | may surface many |
| O | 2262 | NEW RULE timeouts/delays must be named constants | high | 4 | new rule + remediate | **burndown-risk surface; fanout if large** |
| P | 2315 | cross-file rules hard-error when anchor file missing | med | 4 | `_engine` cross-file | serialize after A |
| U | (ROADMAP + Phase 2) | migrate 4 check-*.ts → *.rule.ts + refresh ROADMAP | high | 5 | package.json, am-i-done.ts, hook, rules/ | shared files; serialize vs V/W |
| V | (Phase 4) | NEW RULE dotw-todo-needs-issue meta-rule | low | 5 | new rule | suppression parser already flags |
| W | 2345 | Phase 5: route test+coverage through am-i-done | high | 5 | ci.yml, am-i-done.ts, hooks | serialize after U; shares ci.yml w/ X |
| X | 2311 | _runner tests + add scripts/ to CI | med | 5 | ci.yml, _runner tests | shares ci.yml w/ W |
| Y | 2346 | managed long-lived spawn helper (no-raw-spawn escape hatch) | med | 5 | `packages/core` | independent |

## Dependency / serialization edges

- D blockedBy C (poll-until rule must be correct before burning down its violations)
- E blockedBy F (snapshot suite proves parseFlags migration behavior-neutral)
- P blockedBy A (cross-file hard-error builds on loader hardening)
- W blockedBy U (both edit am-i-done.ts)
- X blockedBy W (both edit .github/workflows/ci.yml — serialize)
- U is hot-shared (package.json / am-i-done.ts / pre-commit) — no other WI edits these concurrently
- Burndowns D/E/G/H: each session fans out per-file with its own subagents; single gate run at end

## Tier launch order (slots backfill via blockedBy, not batch tails)

- **Tier 1 (immediate, parallel):** A, B, C, F, T, Z
- **Tier 2 (burndowns, as slots free):** D(after C), E(after F), G, H
- **Tier 3 (rule fixes, parallel):** I, J, K, L, M, Q, R, S
- **Tier 4 (new rules):** N, O, P(after A)
- **Tier 5 (migrations/infra, serialized):** U → W → X; V, Y parallel

## Context

After #2347 turned the rule gate ON (pre-commit + CI run the full `doing-it-wrong` sweep),
this is the mop-up epic #2352. ~213 dotw-todo suppressions + ~136 live poll-until violations
remain the real debt. Phase 3 (gate wiring) is DONE but ROADMAP still lists it as future —
WI U refreshes it. Use the /rule-author skill for any rule add/extend. Risk: O (#2262) and
N (#2261) are new rules whose remediation surface is unknown until shown-red — treat as
burndowns with fanout if large. Orchestrator must never implement directly.

---

## RUN STATE — live recovery doc (updated 2026-05-24 20:33 ET)

Sprint ran ~6h past the 15:00 rollover; sessions completed autonomously. **Read this first if resuming in a fresh context — it is the authoritative state.** Daemon is converged to ONE clean instance. Original diffs of everything merged live in main history (cherry-pickable).

### DONE — merged to main
I #2319/2320→#2356 · T #2289→#2357 · J #2335→#2358 · Z #2340/2341+#2264reconcile→#2359 · A #2285/2286/2287/2288/2290→#2360 · bun-install #2355→#2361 · G #2322(78 empty-catch)→#2363 · F #2332→#2364 · C #2292/2293→#2365 (also closed D #2291 as FP-obsolete) · S #2337→#2366 · L #2284→#2367 · B #2300/2301→#2368 · K #2336→#2369 · H #2323(25 timers)→#2372 · yoga-flaky #2362→#2379

### MERGED BUT NEEDS FIX-FORWARD — tracked in #2380 (gate currently CLEAN; defects are latent FP-risk)
- Q #2321→#2374: over-broad cwd detection; identifier-only matching; invalid clean fixture (`const cwd` twice)
- M #2314/2327→#2377: `-h` help-flag FP asymmetry; inline-import smell
- N #2261→#2376 (NEW RULE): wrong file scope (runs everywhere); exported-vs-any const mismatch; split() in loop
- R #2342→#2373: clean, needs review pass only
ACTION: reviewed follow-up PR per item.

### OPEN PRs — DO NOT merge without a review cycle
- E #2283 parseFlags 94-site burndown → PR #2378 (MERGEABLE; only red check = #2135 disconnect flaky → rerun, review, merge)
- V phase-4 `dotw-todo-needs-issue` meta-rule → PR #2375 (MERGEABLE; same #2135 flaky; NEW rule → adversarial review then merge)

### RECOVER
- Y #2346 managed long-lived spawn helper: worktree `.claude/worktrees/claude-mpk1bzyf`, branch `feat/issue-2346-managed-spawn`, 13 files staged (1356-line diff; backup `/tmp/sprint63-y-backup/issue-2346-full.patch`). Branch is at OLD main (pre-yoga-fix). ACTION: rebase onto origin/main → commit → push → review → merge.

### NOT LAUNCHED
- O #2262 timeouts→named-constants (burndown-scale; scope carefully)
- P #2315 cross-file rule hard-error (engine)
- U Phase-2: migrate 4 `check-*.ts` (args-bounds/phase-drift/session-teardown/test-timeouts)→`*.rule.ts` + REFRESH `scripts/ROADMAP.md` (Phase 3 done, Phase 2 pkg.json done). Hot-shared files.
- W #2345 route test+coverage through am-i-done (after U; shares ci.yml w/ X)
- X #2311 _runner tests + scripts/ to CI (after W)

### INFRA / BUGS
- #2370 P1 daemon socket-theft (auto-start unlinks live socket) — ROOT CAUSE of split-brain; NOT fixed
- #2371 poll-until string-literal `//` FP edge case — open follow-up
- #2135 disconnect-test flaky (10s) — pre-existing; blocks E/V CI; rerun to clear

### LESSONS (retro)
1. Never merge on green CI alone — always a review cycle (caused #2380).
2. Don't end a turn on a passive event-wait that may not fire — Monitor was bound to an orphaned daemon → 6h blind → ~400k cache miss. Drive actively; bounded polls; keep this doc current.
3. Daemon auto-start steals the IPC socket (#2370) — converge to one daemon before heavy parallel spawning.
4. Pre-commit runs FULL test:coverage for source changes → any test flaky blocks commits; fix flakies fast, never bypass.
