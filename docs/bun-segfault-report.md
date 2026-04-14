# Bun Crash Report Aggregation (mcp-cli)

## Reproduction

The harness is `scripts/segfault-test.sh`. Usage:

```
./scripts/segfault-test.sh <bun-binary> <runs> <label>
```

Test files run per iteration:

```
packages/daemon/src
test/cli-orchestration.spec.ts
test/daemon-integration.spec.ts
test/stress.spec.ts
test/transport-errors.spec.ts
```

Per-iteration timeout: 300s (via `/opt/homebrew/bin/timeout`). The harness writes a summary to `/tmp/segfault-<label>.log` and the full stderr of any crash / timeout / non-zero-exit iteration to `/tmp/segfault-<label>.crashes/run-NNN-*.log`, then prints a deduplicated URL frequency table at the end.

To reproduce:

```
git clone https://github.com/theshadow27/mcp-cli
cd mcp-cli
git checkout repro/bun-segfault
bun install
./scripts/segfault-test.sh $(which bun) 100 baseline
```

## Scan source (historical aggregation)

`Agent(Explore)` scan on 2026-04-12 of all mcp-cli Claude session transcripts (1,785 `.jsonl` files) + repo tree (9,314 files).

## Scope
- `~/.claude/projects/<mcp-cli-project-slug>/` (main project sessions)
- `~/.claude/projects/<mcp-cli-project-slug>--claude-worktrees-*/` (all worktrees)
- `<repo-root>/` (repo: diary, sprint notes, issue bodies, tmp logs)
- `/tmp/segfault-*.log`

**Environment:** macOS aarch64 (local developer machine). **No GHA/CI logs scanned in this pass.**

## Totals
- 326 URL occurrences
- 17 unique signatures
- All Bun 1.3.12, commit `700fc11`

## Deduplicated URL List (by frequency)

| Occurrences | URL (https://bun.report/1.3.12/ + suffix) |
|---:|---|
| 131 | `Mt1700fc11i3BulqoC_2t49G2t49G_27u9gDmok9gDu7szgD+9u7pC20prEun5wZ27tkUm8p0R+91kc+jthXunoI2yv/P2z9sQ2s/kL+r2kL_A2AwO` |
| 66  | `Mt1700fc11i3hgEulqoC_2t49G2t49G_27u9gDmok9gDu7szgD+9u7pC20prEun5wZ27tkUm8p0R+91kc+jthXunoI2yv/P2z9sQ2s/kL+r2kL_A2AwO` |
| 22  | `Mt1700fc11i3Bu1qoC_2t49G2t49G_27u9gDmok9gDu7szgD+9u7pC20prEun5wZ27tkUm8p0R+91kc+jthXunoI2yv/P2z9sQ2s/kL+r2kL_A2AwO` |
| 21  | `lt1700fc11i3BulqoC43ip6E+ypR2z4pjD6z2pjDimj3gD081u9Cut083Co41v2Dyp+v2Dm1+gmEguk12F__m8yqkEi/j02Fo52z2F4g/p7F80ojmEu2xi+CitgyjDA2AA` |
| 15  | `Mt1700fc11i3BulqoC_m5wiWm5wiWm+uiWm3x7Tut9lRuuo2Muv+1mB2gpqIui2zxC__u7szgDu/51xCmw1yxCmllr0Cuwkr0C+u0l2C+tl7B_A2AgB` |
| 12  | `Mt1700fc11i3hgEu1qoC_2t49G2t49G_27u9gDmok9gDu7szgD+9u7pC20prEun5wZ27tkUm8p0R+91kc+jthXunoI2yv/P2z9sQ2s/kL+r2kL_A2AwO` |
| 10  | `Mt1700fc11i3BulqoC_m5wiWm5wiWm+uiWm3x7Tut9lRuuo2Muv+1mB2gpqIui2zxC__u7szgDu/51xCmw1yxCmllr0Cuwkr0C+u0l2C+tl7B_A2AoB` |
| 8   | `Mt1700fc11i3BulooC_2t49G2t49G_27u9gDmok9gDu7szgD+9u7pC20prEun5wZ27tkUm8p0R+91kcupthXunoI2yv/P2z9sQ2s/kL+r2kL_A2AwO` |
| 7   | `Mt1700fc11i3BulqoC_uw+6Tuw+6Tm5wiWm+uiWm3x7Tut9lRuuo2Muv+1mB2gpqIui2zxC__u7szgDu/51xCmw1yxCmllr0Cuwkr0C+u0l2C+tl7BA2AgB` |
| 7   | `lt1700fc11i3BulqoC43ip6E+ypR83lprE_spzykE2yqykEm8yqkEsx0kuFkq90wE4/qtnDug0ihDqh0i+Cw95lqDm1hwkD4hzvsEsqg/7Cy15v8C6loj2Cov+i2Cy8wKA2AgigF` |
| 5   | `Mt1700fc11i3BulqoC_m5wiWm5wiWm+uiWm3x7Tut9lRuuo2Muv+1mB2gpqIui2zxC__u7szgDu/51xCmw1yxCmllr0Cuwkr0C+u0l2C+tl7B_A2AQ` |
| 5   | `Mt1700fc11i3BulqoC_+s0lR+5wlRu5q2Mmiv2Mu0w2M+9x2M2xpkc+jthXunoI2yv/P2z9sQ2s/kL+r2kL__A2m1B948li+D` |
| 4   | `Mt1700fc11i3BulqoC_290lR290lR+5wlRu5q2Mmiv2Mu0w2M+9x2M2xpkc+jthXunoI2yv/P2z9sQ2s/kL+r2kL__A2s02ikHhwj+74D` |
| 4   | `Mt1700fc11i3BulqoC_+s0lR+5wlRu5q2Mmiv2Mu0w2M+9x2M2xpkc+jthXunoI2yv/P2z9sQ2s/kL+r2kL__A269Ck07/F` |
| 3   | `Mt1700fc11i3BulqoC_m5wiWm5wiWm+uiWm3x7Tut9lRuuo2Muv+1mB2gpqIui2zxC__u7szgDu/51xCmw1yxCmllr0Cuwkr0C+u0l2C+tl7B_A2Cps////D` |
| 3   | `Mt1700fc11i3Bu1qoC_2t49G2t49G_27u9gDmok9gDu7szgD` (truncated in logs) |
| 3   | `lt1700fc11i3BulqoC43ip6E+ypRsop2gD2z4pjD6z2pjDimj3gD081u9Cut083Co41v2Dyp+v2Dm1+gmEguk12F_2yqykEm8yqkEi/j02Fo52z2F4g/p7F80ojmEu2xi+CA2DkljB` |

## Clusters

### Cluster A — `Mt…Bul…` (219 total, 67%)
Dominant crash family. All resolve (per user's manual decode of examples) to `WebCore::jsWorkerPrototypeFunction_terminateBody` → `JSC::Interpreter::executeCallImpl` → `Bun__JSTimeout__call` → timer-driven `Worker.terminate()` call during test cleanup.

Sub-variants:
- `BulqoC_2t49G…A2AwO` — 153 (including `Bu1`, `Buloo` positional variants)
- `BulqoC_m5wiWm…` — 32 (with A2AgB/A2AoB/A2AQ/A2Cps tail variants)
- `BulqoC_+s0lR` / `_290lR` — 13
- `BulqoC_uw+6T` — 7

### Cluster B — `Mt…hgE…` (78 total, 24%)
Secondary path. User decoded one: nearly identical stack (`jsWorkerPrototypeFunction_terminate`), but `runAllTests.Context.begin` at `test_command.zig:1840` vs `:1846` in Cluster A, and the `dotenv` feature is present. **Same bug, different test-run config.**
- `hgEulqoC_2t49G…` — 66
- `hgEu1qoC_2t49G…` — 12

### Cluster C — `lt…Bul…` (31 total, 9%)
Distinct from `Mt` (lowercase `l` vs `M` prefix byte → different panic type or calling convention).
- `43ip6E+ypR2z4pjD` — 21
- `43ip6E+ypR83lprE` — 7
- `43ip6E+ypRsop2gD` — 3

## Decoded Stack (user-provided, representative)

Both `BulooC_…A2AwO` and `hgEu1qoC_…A2AwO` resolve to:

```
WebCore::jsWorkerPrototypeFunction_terminate(Body)
  → JSC::Interpreter::executeCallImpl
  → Bun__JSTimeout__call (NodeTimerObject.cpp:84)
  → bun.js.api.Timer.TimerObjectInternals.fire (TimerObjectInternals.zig:183)
  → bun.js.api.Timer.All.drainTimers (Timer.zig:328)
  → bun.js.event_loop.autoTick (event_loop.zig:412)
  → cli.test_command.TestCommand.run (test_command.zig:1973)
  → runAllTests.Context.begin (test_command.zig:1846 or :1840)
  → TestCommand.runAllTests / exec → cli.start / main
```

Segfault at `0x000000E8` — small-offset null-pointer dereference, consistent with UAF on a freed Worker impl struct (matches PRs #27960, #28795).

## Encoding Notes (per user)

- bun.report URLs encode the stack trace directly in the URL (zlib/base64-ish).
- No server side-channel: identical suffixes → identical decoded stacks.
- Early prefix bytes (`Mt` vs `lt`, `Bul` vs `hgE`) appear to encode panic-type + callsite hash.
- Trailing `A2AwO`/`A2AgB`/etc. are likely ASLR-normalized return addresses.
- Features list (spawn, workers_*, dotenv, etc.) is encoded toward the tail.

## Taxonomy for Upstream Report

Grouping by first 25-30 chars of suffix (filters ASLR noise):

| Group | Count | Top prefix |
|---:|---:|---|
| 1 | 153 | `Mt1700fc11i3BulqoC_2t49G` |
| 2 | 66  | `Mt1700fc11i3hgEulqoC_2t49G` |
| 3 | 32  | `Mt1700fc11i3BulqoC_m5wiWm` |
| 4 | 21  | `lt1700fc11i3BulqoC43ip6E+ypR2z4pjD` |
| 5 | 13  | `Mt1700fc11i3BulqoC_+s0lR` / `_290lR` |
| 6 | 7   | `lt1700fc11i3BulqoC43ip6E+ypR83lprE` |
| 7 | 7   | `Mt1700fc11i3BulqoC_uw+6T` |
| — | 27  | other (9 minor signatures) |

---

# PR Validation Matrix (2026-04-13 → 2026-04-14)

Environment: macOS aarch64 (Darwin 25). Test tree: mcp-cli at `00f5b7bf` (parent of #1389, worktree `/tmp/mcp-cli-pre1389`). Test files: `packages/daemon/src test/cli-orchestration.spec.ts test/daemon-integration.spec.ts test/stress.spec.ts test/transport-errors.spec.ts`. Harness: `segfault-test.sh` / `segfault-test-v2.sh` (v2 = captures per-run stderr to `*.crashes/`). Each run: 100 iterations, 300s per-iter timeout.

## Binaries tested

| Label | Bun revision | Source |
|---|---|---|
| 1.3.12 baseline | 1.3.12 | pre-built release |
| bunx PR-29180 | 1.3.13-canary.1+95e22efe4 | `bunx bun-pr 29180` artifact |
| main (control) | 1.3.13-canary.1+d7526e2dc | local `bun run build:release` at main HEAD (31 commits past 1.3.12) |
| main + #29180 | 1.3.13-canary.1+1f60bcb42 | main rebased with PR #29180 |
| main + #28795 | 1.3.13-canary.1+dc21bf384 | main rebased with PR #28795 |
| main + #27960 | 1.3.13-canary.1+99af6878e | main rebased with PR #27960 |
| main + #29277 | 1.3.13-canary.1+46a2a6bdb | main rebased with PR #29277 |

## Results

| Run | Binary | Runs | Passes | Segfaults | Other failures | Segfault rate | Concurrency |
|---|---|---:|---:|---:|---:|---:|---|
| prior | 1.3.12 baseline | 37 | 15 | 22 | 0 | 59% | solo |
| bs2i4srvh | bunx PR-29180 | 100 | 99 | 0 | 1 | 0% | 1 other (overlapping part) |
| bbpiikone | main (d7526e2) | 100 | 91 | 5 | 4 | 5% | 1 other (overlapping part) |
| bqdheopyd | main (d7526e2) | 100 | 87 | 9 | 4 | 9% | 4 concurrent |
| bigzlhso3 (v2) | main (d7526e2) | 100 | 92 | 2 | 6 | 2% | 6 concurrent |
| bwvksf7cn | main + #29180 | 100 | 99 | 0 | 1 | 0% | 4 concurrent |
| bm3r8q1en | main + #28795 | 100 | 99 | 0 | 1 | 0% | 4 concurrent |
| bjy5ctwxs | main + #27960 | 100 | 99 | 0 | 1 | 0% | 4 concurrent |
| bdshdcewu (v2) | main + #29277 | 100 | 94 | 2 | 4 | 2% | 6 concurrent |

## Captured crash URLs (v2 script)

**main (d7526e2), 2 segfaults:**
```
https://bun.report/1.3.13/Mt2d7526e2i3BulooC_u577cu577c2h59G_2lo79Cmy969Curlx9C+y++nC2g2qEu+z0iB2p73mB+tzvL2l6+Rms4+Rm03HmwkqR+/pzeu1w5cmlw5cA2AwO
```
(both crashes identical signature)

**main + #29277, 2 segfaults:**
```
https://bun.report/1.3.13/Mt246a2a6bi3BulooC_utm6cutm6cmu59G_2l079Cmyp79Curxx9C++q/nC2g2qEmr3yiBm956mBujwpLmnw/R2tu/Rm03Huu6nR290je+285c2m85cA2AwO
```
(both crashes identical signature)

main + #29180, main + #28795, main + #27960: 0 segfaults each, no URLs captured.

v1-script runs (bs2i4srvh, bbpiikone, bqdheopyd): stderr discarded by harness, URLs not captured.

