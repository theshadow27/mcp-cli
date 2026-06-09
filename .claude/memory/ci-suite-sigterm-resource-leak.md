---
name: ci-suite-sigterm-resource-leak
description: "Large bun test suite killed by SIGTERM at ~97% on Linux CI with 0 failures = a resource leak in test files. A hang / near-end SIGTERM is a STOP-and-fix-root-cause signal, never something to paper over with a killer/reaper/timeout-bump."
metadata: 
  node_type: memory
  type: project
  originSessionId: e2a208bd-8eff-4c73-a4cd-67fa30b8c0bc
---

**The lesson is STOP-and-fix-the-root-cause, not contain-the-symptom.** A near-end SIGTERM, a hung process, or a worker that won't exit is a **STOP signal**. The correct fix makes hanging/leaking *impossible* — remove the process-global, drain the pipe, close the handle. It is **never** a killer, reaper, watchdog, host-wide `ps`+kill, concurrency cap, or timeout-bump: those hide the leak and *became the disease* in the sprint 69/70 collapse (band-aids stacked on band-aids, all reverted in #2637). **No worker should be able to hang. If one does, that is the bug to fix first — before any other sprint work.** "Just kill the hung one and move on" is how you ship the leak to every future run.

When a large `bun test` invocation is killed by **SIGTERM near the end of the run (~96–97%) with ZERO assertion failures**, passes on macOS, and passes in isolation — the cause is a **resource leak / process-global mutation in one or more test files accumulating across the shared single-process run** until the Linux runner's cgroup limits (fds / pids / memory) trip and the OS kills it. It is NOT "too many tests / a magic size threshold," and not a generic bun teardown bug.

**Why:** the death point *varies* across runs (whatever file is loading when the cap trips) and is always near the end — the signature of slow accumulation, not a specific failing test. Re-running ("if it doesn't explode it's fine") only confirms your prior; it never localizes the leak.

**How to diagnose:** do NOT brute-force-rerun and do NOT reason from your armchair (I lazily called it a "size threshold ~215 files" — wrong). Launch **adversarial reviewers with NO preconceived theory** to deep-dive the suspect files (the ones newly added to the failing batch) for: process-global mutation (signal handlers via `process.on`/`once`, `process.env` writes, `chdir`, monkey-patching `process.stdout/stderr.write`, module singletons), spawned-process pipes drained only on the error path (fd leak per success), unclosed handles (WAL SQLite, sockets, timers, watchers, temp dirs), and whole-repo reads into memory.

Concrete instance (post-69/70 cleanup, 2026-06): #2641 → #2644. Same cleanup family as the CPU-wedge incident but a **distinct root cause** — a resource leak, not the test-worker CPU wedge. check-no-claude (full suite) had been red since #2609 because the #2613 coverage gap meant agent-grid + scripts/* root specs were never scrutinized, and they leaked: a process-global SIGINT/SIGTERM handler in `agent-grid/src/isolation.ts` (also the #2586 origin), `process.env.X = undefined` (sets the string `"undefined"`, poisons later git tests — use `delete`), `loadFiles` reading the whole repo every call, a `process.stdout/stderr.write` monkeypatch, undrained `tar`/`npm` spawn pipes, and unclosed WAL handles. Fixing them turned check-no-claude green for the first time since #2609.

Related: [[cpu-wedge-test-workers]] — same family of lesson (the band-aid killers were the disease; don't fix a leak with a process killer / host-wide ps+kill).
