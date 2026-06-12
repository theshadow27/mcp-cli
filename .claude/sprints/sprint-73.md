# Sprint 73

> Planned 2026-06-11 11:20. Target: 18 PRs. Amended 13:45 after the am-i-done
> investigation (pre-sprint gate added; #2690/#2740 promoted to batch 1).
> Started 2026-06-12 13:20 (RUN ONLY)

## Goal

Get the stdio transport working: diagnose and fix the spawn-exit that killed both
sprint-72 canaries, close the observability gaps that made the failure undiagnosable,
make the documented containment go/no-go decision, and validate stdio at real fleet
concurrency.

## Issues

| # | Title | Scrutiny | Batch | Model | Provider | Category |
|---|-------|----------|-------|-------|----------|----------|
| 2738 | stdio child stderr not captured — spawn-failure postmortems impossible | medium | 1 | opus | claude | goal |
| 2721 | compiled mcpd: ACP session worker ModuleNotFound (worker-path.ts) | medium | 1 | opus | claude | goal |
| 2714 | --claude-binary validation: directory passes X_OK; relative-path untested | low | 1 | sonnet | claude | goal |
| 2722 | ACP fs/read_text_file bypasses ContainmentGuard (read-path parity with #2720) | low | 1 | opus | claude | filler |
| 2741 | CI: stop pulling 59MB LFS blob on every checkout (bandwidth gate 403s CI) | medium | 1 | opus | claude | infra-P1 |
| 2719 | phasesTestWithCrashTolerance fails open on 0 discovered specs | low | 1 | fable | claude | filler |
| 2688 | stdio spawn-exit investigation + canary retry + containment go/no-go | high | 2 | opus | claude | goal |
| 2709 | audit log + monitor event for spawnDisabledReason bypass via --claude-binary | low | 2 | sonnet | claude | goal |
| 2717 | CI detect: .claude/phases/*.ts misclassified docs-only, gates skipped | low | 2 | fable | claude | filler |
| 2729 | flaky: ConfigWatcher scheduleReload debounce timer-count assertion | low | 2 | sonnet | claude | filler |
| 2732 | ACP handleFsWrite: no size cap on agent-supplied content (disk DoS) | low | 2 | opus | claude | filler |
| 2562 | state mutation before write in sendPrompt/respondToPermission/interrupt | high | 3 | opus | claude | goal |
| 2739 | multi-session stdio pipe-drain load test (P2 deadlock risk from #2234) | medium | 3 | opus | claude | goal |
| 2723 | /tmp allowlist: silent cross-session writes via provider fs ops — policy + event | medium | 3 | opus | claude | goal |
| 2509 | stale-daemon split-brain: client/daemon build-mismatch check at spawn | medium | 3 | opus | claude | goal |
| 2696 | rule: flag `{ env: { ...process.env } }` in specs without GIT_DIR strip | low | 3 | sonnet | claude | filler |
| 2740 | EventBus teardown-order fix (closed-db append) — gate satisfied 2026-06-11 | high | 1 | opus | claude | goal |
| 2690 | cooperative gate-run lease K≤2 (oversubscription) — gate satisfied 2026-06-11 | high | 1 | opus | claude | goal |
| 2754 | ci-steps retry classifier: signal-killed children never match panic predicate | medium | 1 | opus | claude | goal |

## Pre-sprint gate (added 2026-06-11 after the am-i-done investigation — see #2744/#2690 comments)

The investigation verdict is **no-go for 8–12 concurrent gate runs** until these land.
Do NOT start batch 1 before all three are merged:

1. **#2703 fix** — replay.ts hard-coded 3s handshake deadline → condition-poll.
   Owned by the `investigate/ws-patch-120-173` session; verify merged, don't re-fix.
2. **PR #2748** (fixes #2744) — restores the CI per-file coverage gate (classifier
   regex false-pass) + fills the 4 genuine coverage gaps. Auto-merge armed.
3. **#2690 + #2740 promoted into batch 1** (both high scrutiny, opus, adversarial
   review per investigations.md — their nerd-snipe gates are satisfied by the
   2026-06-11 investigation comments):
   - #2690: cooperative gate-run lease (K≤2), queue-never-kill, orchestration layer
     ONLY — any in-runner cap/watchdog/killer shape is an auto-reject (#2637 doctrine).
   - #2740: teardown-ordering fix — unsubscribe event-log/budget-watcher consumers
     BEFORE db.close() in test teardown; no try/catch swallowing.
   - #2754 (added 16:10): CI crash-tolerance classifier misses signal-killed
     children (code=null + SIGSEGV never matches the 132/139 retry predicate) —
     hit 2 of 3 CI check runs on 2026-06-11 afternoon, always at the same spec
     boundary right after the bun-segfault-repro spec; root cause + fix shape
     documented on the issue (surface `signal` from runBun, extend predicate).
     This is a retry-classifier completion, NOT a new killer/cap — in scope.

Until #2690's lease exists, the orchestrator runs gates **serially** (at most 2
concurrent sessions in gate-running phases).

## Batch Plan

### Batch 1 (immediate, after the pre-sprint gate clears)
#2740, #2690, #2738, #2721, #2714, #2722, #2719, #2741

### Batch 2 (backfill)
#2688, #2709, #2717, #2729, #2732

### Batch 3 (backfill)
#2562, #2739, #2723, #2509, #2696

### Stretch
(none — #2740 was promoted to batch 1 on 2026-06-11 after its investigation gate
was satisfied; see Pre-sprint gate section.)

### Dependency edges (translate to addBlockedBy at run time)

- #2688 blockedBy #2738 (stderr capture must land before the investigation's retry-spawns, or the failure stays undiagnosable)
- #2709 blockedBy #2738 (ws-server.ts hot-file serialization)
- #2562 blockedBy #2709 (ws-server.ts hot-file serialization — 2,634-line god file, #2500)
- #2739 blockedBy #2688 (can't load-test a transport that dies at spawn; needs the root-cause fix merged)
- #2732 blockedBy #2722 (both touch the ACP session fs handlers — serialize to avoid logical merge conflict)
- #2717 blockedBy #2741 (both edit .github/workflows/ci.yml; LFS fix is the urgent one, goes first)

### Hot-shared files

- `packages/daemon/src/claude-session/ws-server.ts`: #2738 → #2709 → #2562, fully serialized via edges above.
- ACP session fs handlers: #2722 → #2732 serialized.
- `packages/core/src/containment.ts`: #2723 only — but broadcast a rebase directive if #2688's containment decision lands code there too.

## The stdio arc (how the goal issues compose)

1. **#2738 first** — recon (Explore, plan-time) found stderr is already piped and
   `proc.stderrTail()` is retrieved at exit (ws-server.ts ~904, #546 drain pattern);
   the gap is that the tail isn't logged/attached on the `spawn exited` disconnect
   path or the daemon ring buffer. Likely a wiring fix, not new plumbing.
2. **#2688 is a nerd-snipe investigation gate** (references/investigations.md —
   `mcx claude spawn` with persona inlined, NOT the Agent tool, per #2009). Mandate:
   root-cause the immediate child exit (both sprint-72 canaries, `spawn exited`
   within ~3s, ws siblings fine). Plan-time hypotheses to check: `buildSpawnCmd()`
   passes `--output-format stream-json --input-format stream-json` with no
   `--sdk-url` — verify claude 2.1.170's flag prerequisites for stream-json modes
   (e.g. print-mode/`--verbose` requirements); cwd/env (CLAUDECODE unset, PWD);
   compiled-daemon worker resolution (cf. #2721). Deliverables: root cause + fix,
   the documented containment (`can_use_tool`) go/no-go decision (see the two specs
   added as comments on #2688), and StuckDetector signal verification. Hard-fail
   outcome `needs-attention` is acceptable.
3. **Canary retry** at full fleet concurrency once #2688's fix merges — early enough
   in the sprint to hit the multi-session regime, per the #2688 protocol. #2739
   then mechanizes the load test so this never regresses silently.
4. **#2509** protects the canary procedure itself: build-mismatch split-brain
   produces exactly the silent disconnected-session signature that would
   contaminate canary evidence.

## Context

Sprint 72 closed the containment trust boundary fail-closed across all providers and
landed the per-spawn `--transport`/`--claude-binary` flags (#2681 via PR #2706), but
the stdio canary aborted: both workers died at spawn, undiagnosable because child
stderr wasn't surfaced. #2738/#2739 were filed at plan time; containment and
StuckDetector specs were added as comments on #2688. Security follow-ups from the
sprint-72 reviews (#2722, #2732, #2723) ride along as filler/goal-adjacent. Codex
remains broken (#2482) — no codex routing. Fable continues its expansion (2/2 clean
two sprints running) with two low-scrutiny slots (#2719, #2717).

Excluded but considered: #2508 (monitor liveness — orthogonal, defer), #2727/#2737
(worktree phase-check cluster — defer until after stdio lands), #2662/#2660
(worktree GC hygiene), #2650 (site binary corruption), #2690 (am-i-done host flock —
deliberately NOT this sprint to avoid multiplying variables during the canary),
#2716 (needs caller-identity infra).
