---
name: Early bun-test segfault = check machine load first
description: am-i-done aborting early with a Bun segfault / mass "worker panicked" cascade is usually host CPU starvation (orphaned processes), not a code bug
type: project
originSessionId: c79e8a14-b2dc-4edf-a226-4dfe70a8e537
---
When `bun run am-i-done` aborts EARLY (~25-30s, vs ~45s clean or ~15min full) with
`panic: Segmentation fault` + a mass cascade of `(aborted: worker panicked)` /
`(worker crashed: SIGTERM)` across many spec files, the segfault is almost always a
**Bun runtime bug exposed by host CPU starvation**, not your change.

**Why:** the parallel test runner spawns many workers; under extreme load average the
Bun worker segfaults (known `bun test-workers` crash class), which SIGTERMs the rest.
It reproduces on ANY tree, including clean main, when the box is starved.

**Diagnose before treating as a real failure:**
- `uptime` / `sysctl -n vm.loadavg` — load ≫ core count (saw 454 on a 16-core box) is the tell.
- `ps -Ao pid,ppid,%cpu,etime,command -r | head` — look for many PPID=1 (orphaned) `bun` processes.
- Investigation sessions that "induce contention" leave **`bun build/burn.ts`** CPU-burn
  workers running (round-2 #2825 left ~50 orphaned for ~11h). `pkill -9 -f "build/burn.ts"`.

**Why:** wasted ~30min on #2825 round 2 chasing phantom test failures that were just the
prior investigation's leftover burn workers. Load-avg decays with a ~1min time constant —
after killing, wait until 1-min avg < ~30 before re-running the gate.

**How to apply:** before concluding an early-segfault am-i-done failure is real, check load +
orphaned procs. NEVER "fix" it with a killer/reaper in code (that's the disease, per
cpu-wedge-test-workers memory). If it reproduces on a genuinely idle box → then it's a real
Bun crash: open the bun.report URL and file a fresh issue. Also: never run two `am-i-done`
concurrently — they share `~/.mcp-cli` state + ports and cross-fail each other.
