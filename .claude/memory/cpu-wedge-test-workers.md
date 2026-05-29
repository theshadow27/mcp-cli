---
name: cpu-wedge-test-workers
description: "bun test-worker 100% CPU wedge during parallel sprints — root cause, band-aid reaper, unlanded fix"
metadata: 
  node_type: memory
  type: project
  originSessionId: 17e9dca3-6aa4-46d0-82f2-89bea91bfcc8
---

During parallel sprint orchestration (N sessions each running `bun run am-i-done` → `bun test --parallel --max-concurrency=20`), `bun test --test-worker` children wedge at 100% CPU and never exit, saturating the machine (sprint 69 hit load average 117 on a ~10-core box).

**Root cause (#2597, nerd-snipe-confirmed):** a zero-backoff `madvise(MADV_DONTDUMP)` EAGAIN retry loop in bun's bmalloc `SYSCALL` macro. Under memory pressure the kernel `mmap_write_lock` is contended → `madvise` returns EAGAIN → bmalloc retries with no delay → 100% CPU. Upstream [bun#27490](https://github.com/oven-sh/bun/issues/27490) (closed as dup of still-open #17723) + [bun#27766](https://github.com/oven-sh/bun/issues/27766), both unfixed, reproduced on 1.4.0-canary; Rust rewrite unreleased (latest tag 1.3.14 = what we run). `--timeout=5000` can't catch it (spin is in the allocator AFTER the test body passed); SIGTERM is ignored — **only `kill -9` works**.

**Trigger we control:** multiplicative oversubscription (N sessions × 20 workers) → free-RAM floor → EAGAIN. So the **primary fix is the concurrency cap**, not the watchdog.

**Band-aid (sprint 69):** an in-session `Monitor` reaper loop killing `bun test --test-worker` with >90s ELAPSED (not CPU — under contention a starved spinner accrues CPU-time too slowly to trip a CPU-time threshold; elapsed is the right metric). Dies when the orchestrator session ends — NOT persistent.

**Unlanded real fix (sprint 70 P1 #1):** (1) cap `--max-concurrency` in `scripts/am-i-done.ts`, scaling down when sibling am-i-done runs are detected (a global lock / file sentinel); (2) a watchdog that `SIGKILL`s the worker's process GROUP past ~2× timeout. Risky to land mid-sprint — it changes the shared test runner every session + CI depends on. Land it isolated, first thing, before spawning a sprint's worker fleet. Productize the reaper into `orphan-reaper.ts` on an interval so it survives beyond an orchestrator session.

Related: leaked `bun test/echo-server.ts` fixtures (12-15min old) seen alongside — separate orphan-cleanup gap, note if it recurs. See [[feedback_codex_retro]] for other stale-process lessons.
