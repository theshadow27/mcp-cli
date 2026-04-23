---
name: Phase run loop must not use --dry-run
description: Sprint-orchestrator per-tick pattern; dry-run skips state + transition log writes; always run mcx phase run <phase> --work-item before spawning or transitioning
type: feedback
originSessionId: e8b5dc8f-145f-44ea-863e-93df666ce7da
---
**Rule:** In the sprint per-tick loop, call `mcx phase run <item.phase> --work-item '#N'` **without** `--dry-run`. Execute the returned `command` for `action: spawn`. Never skip `mcx phase run impl` for a tracked work item, even if you spawn the session manually.

**Why:** Both `--dry-run` and bypassing `mcx phase run impl` entirely skip the persistence path wired in via #1381. The non-dry-run path writes:
- **Phase state** (provider, model, labels, `session_id="pending:*"` sentinel via `impl.ts:117`)
- **Transition log entry** to `.mcx/transitions.jsonl` — the authoritative source for "from" phase inference

Without those, later phase transitions fail with `(initial) → <target> is not an approved transition`. Sprint 41 hit this on #1398, #1601, #1570 because I did `mcx track` → `mcx claude spawn` directly, skipping `mcx phase run impl`. Triage then blew up. Workaround was `--from impl` (hacky) or run `impl` once (proper).

User-confirmed fix landed on `run.md` main 2026-04-23 — it documents the non-dry-run loop + the `in-flight` return value. Drop-in pattern:

```
result = mcx phase run <item.phase> --work-item <item.id>
case result.action:
  "spawn":     execute result.command, then phase_state_set session_id=<real>
  "in-flight": session already running — no action this tick
  "wait":      continue
  "goto":      mcx phase run <result.target> --work-item <item.id>
               then update work_item.phase = result.target
```

**How to apply:**
- After `mcx track <n>`, run `mcx phase run impl --work-item '#n'` first. Only then execute the returned spawn command.
- Do **not** manually `phase_state_set model/provider/labels` — impl.ts writes them. Only the real session ID replacement + worktree_path + spawn-failure session_id delete are yours.
- Do **not** use `--from impl` as a triage workaround unless filing an issue. If triage still fails with a proper phase-run sequence, that's a bug (filed #1623).
- Only update `work_item.phase` manually on `goto` results.
- `--dry-run` is a **preview-only** tool. Never in the loop.

Until Monitor Phase 4–5 lands (#1580 derived rules, #1584 waitForEvent), the orchestrator still owns all onIdle judgment (PR pushed? CI green? bye + goto?). Don't expect `mcx phase tick` or similar primitive — the Monitor epic supersedes that direction.
