---
name: cpu-wedge-test-workers
description: "bun test-worker CPU wedge — CORRECTED: the band-aid killers were the disease, not the cure. Never fix a leak with a process killer."
metadata: 
  node_type: memory
  type: project
  originSessionId: 17e9dca3-6aa4-46d0-82f2-89bea91bfcc8
---

**⚠️ This memory previously recorded the WRONG conclusion (that the fix was a concurrency cap + SIGKILL-pgroup watchdog). That prescription was the disease. Corrected in sprint 70 — read the retro `.claude/diary/20260530.70.md` before touching test-runner concurrency.**

## What actually happened (sprint 70, empirically proven)

The "bun test-workers wedge the box at 100% CPU and accumulate" symptom was **caused by the mitigations built to manage it**, not by a real product/test leak:

- **Two machine-wide `ps`+SIGKILL killers** ran during every test run: `test/orphan-sweep.ts` (preloaded into EVERY worker via bunfig — `ps -A` + SIGKILL any `--test-worker`/`*echo-server.ts` **across the whole host**) and `scripts/_runner/watchdog.ts` (#2597 — `ps` + SIGKILL any `--test-worker` over a 180s elapsed threshold, also host-wide, no process-tree scoping).
- Plus a **concurrency cap** (#2597/#2632) that throttled CI coverage to ~2 workers → a **~40× regression** (sub-minute suite → 30 min), which then "needed" a timeout bump (#2634).
- These formed a **self-reinforcing loop**: cap slows runs → more workers cross 180s → watchdog SIGKILLs merely-*slow* (not hung) workers → SIGKILL orphans their children → orphan-sweep kills more → load climbs → more cross the line. Twice hit load 25+, forced a reboot.

**The proof:** with all of it reverted (PR #2637), the exact command that wedged for 60 min runs **full coverage in ~45s, 0 surviving processes, no wedge.** There was no leak. The user only ever ran ONE sprint at a time — the "N sessions × 20 workers" multiplicative-oversubscription premise was false.

## The upstream bun spin is real but was NOT the sprint-70 cause

There IS a genuine bun bmalloc `madvise` EAGAIN spin upstream ([bun#27490](https://github.com/oven-sh/bun/issues/27490) → dup of open #17723, + #27766; we run 1.3.14, last Zig release before the Rust rewrite). But in **normal single-run operation it does not trip** — 45s clean proves it. Whether Bun's Rust rewrite retires it is tracked in **#2633**. Do not build mitigations on the assumption it fires in normal use; it doesn't.

## The rule (load-bearing)

- **A process killer is NEVER the fix for a resource leak.** If something leaks, fix teardown at the source (`await using`, afterEach/afterAll). 
- **Never `ps -A`/`ps -e` + kill by command pattern.** That reaches outside your own process tree and murders other worktrees', other repos', and humans' runs + shared fixtures. A test preload reaching host-wide is categorically insane.
- **A large regression (e.g. 40×) is a STOP signal, not a config to accommodate.** Don't bump a timeout to tolerate it.
- **Never measure a leak while a leak-killer is active** — the sprint-70 "agent-grid runs clean, 0 survivors" reading was contaminated (orphan-sweep was still preloaded, killing the evidence before the count). 
- If a genuine spin ever recurs: scope any mitigation to the run's OWN child PIDs (tracked, not `ps`-discovered), pin bun / file upstream, and prefer reducing `--max-concurrency` for THAT run only — never a global killer, never a host-wide `ps` sweep.

See [[feedback_codex_retro]] for other stale-process lessons. The deleted files (`watchdog.ts`/`concurrency.ts`/`orphan-sweep.ts`, #2597/#2415/#2459) stand in git history as the cautionary precedent.
