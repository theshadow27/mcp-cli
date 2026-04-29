# Sprint 49 — Tentative outline

> Drafted 2026-04-29 mid-sprint-48. Not a planning artifact — a sketch
> for the sprint-48 retro to read. The actual plan lands at
> `/sprint plan` time and may diverge based on sprint-48 outcomes.

## Goal candidate

**"Prove the monitor-stream playbook + close out the Monitor Epic + sprint-48 carry-over."**

The structural pull on sprint 49 is that **it is the first sprint to
actually use the new `run.md` monitor-stream playbook.** Sprint 48
shipped the migration (PR #1871, closes #1875) but uses the old
playbook for its own run — the in-flight orchestrator reads `./` not
the worktree. Real use of the new dispatch table will probably surface
2–3 papercuts (mcx monitor flag mismatches, missing event types in the
case table, payload shape drift) → file + close in-sprint. That is the
implicit anchor.

## Bucket 1 — Monitor Epic closeout (single batched PR)

6 polish issues bundled into one PR for a clean record:

| # | Title |
|---|-------|
| 1565 | cmdMonitor --timeout integration test (stream abort + exit 0) |
| 1572 | /events?since= backfill integration test |
| 1787 | gap control message should include `ts` field |
| 1725 | rename MAIL_RECEIVED / publishMailReceived() to send semantics |
| 1791 | CopilotPoller rate-limit warning log |
| 1792 | normalize last_poll_ts sentinel format |

~1 sonnet session. After this PR merges, the `monitor-epic` label has
zero open issues. Close the epic (#1486) with the diary entry.

## Bucket 2 — Sprint 48 carry-over (4–5)

From sprint-48's deferred / backup list:

- **#1812** fix(sites): handleBrowserStart empty/sparse arrays
- **#1848** test(harness): startTestDaemon PATH override
- **#1604** mcx claude spawn help text correction (trivial doc)
- **#1819** agent.ts/claude.ts 'Error:' followup (only if #1798's
  implementer didn't naturally cover it)
- Plus whatever drops from sprint-48's 15 (history says ~1–2 typically slip)

## Bucket 3 — Flaky mini-batch (3–4)

**Containment cluster** — 5 issues all sharing the same `/tmp`
env-sensitivity, multi-sprint deferred. Likely solvable with one PR
that adds proper test isolation (e.g. fixture that pins cwd outside
`/tmp` or normalizes path comparisons):

| # | Title |
|---|-------|
| 1689 | ContainmentGuard symlink test assumes process.cwd() outside /tmp |
| 1687 | symlink traversal test fails when runner CWD is under /private/tmp |
| 1743 | symlink traversal test environment-sensitive when cwd is in /tmp |
| 1770 | symlink traversal test environment-sensitive when run from /tmp |
| 1794 | symlink traversal test fails when running from /tmp (cwd artifact) |

Plus 1–2 of:
- **#1811** flaky server-pool SIGTERM disconnect
- **#1825** flaky offline git-remote-mcx
- **#1841** liveBuffer overflow gap control message tests
- **#1838** liveBuffer backfill async timing

## Bucket 4 — Anchor (high scrutiny, 1)

Pick ONE based on sprint-48 retro signals:

- **#1602** slim builds (standalone `mcx-agent`, `mcx-call` binaries) —
  IF the user wants it as the anchor; needs design doc upfront (build
  strategy: multi-entry Bun build vs separate `entries/` files). Big
  effort, ~60+ min orchestration alone.
- **#1865** async gh in phase ticks — perf, 6 phase scripts touched,
  daemon-side gh cache. Medium-high. Real measured pain (rate-limit
  exhaustion noted sprint 43+).
- **TBD from sprint 48** — dispatch-table papercuts that surface during
  sprint 49 may earn priority; e.g. if `mcx monitor --max-events 1`
  has a subtle exit-code or buffering bug that breaks the per-tick form,
  fixing it is the anchor.

## Bucket 5 — Filler / new from sprint 48 (3–5)

History: ~4 issues filed during a sprint typically become next-sprint
candidates. Cannot enumerate ahead of time.

## Stretch (room permitting)

- **#1517** Atlassian OAuth DCR (P0 for users; production-broken; open
  since sprint 41 — kept slipping)
- **#1827, #1829, #1831** claude-patch + TLS hardening — coupled to
  #1808 daemon spawn-target which landed sprint 47

## Retro-time meta cleanup (sprint-49 prep, not picks)

These belong in the sprint-48 retro or a between-sprint meta-fix PR:

- **Regenerate arcs.md fresh via `/board-overview`** (the sprint-41-era
  snapshot was dropped at sprint-48 mid-run; next strategic snapshot
  will be ~6 sprints fresher)
- **#1806** CI skip docs-only branches — the sprint-container PRs spend
  ~2-3 min/PR on irrelevant CI; quick win once sprint cadence stabilizes
- **#1863** memory audit automation (only if user prioritizes the
  contradiction-detection work)
- Any sprint-48 retro lessons that apply to skill prose

## Target

- **PRs:** 12–15
- **Time:** ~3–4h orchestrator-active
- **Models:** 1 opus anchor + 11–14 sonnet
- **Risk concentration:** dispatch-table validation in real use
  (the new monitor-stream playbook)

---

# Fallback — previous run.md pipeline loop (preserved verbatim)

> Backup section. The prose below is the `mcx claude wait`-based
> orchestrator loop that lived in `.claude/skills/sprint/references/run.md`
> through sprint 47. It was migrated to the `mcx monitor` stream pattern
> in sprint 48 (PR #1871, closes #1875). If the new pattern surfaces a
> serious bug during sprint 49 — e.g. the `mcx monitor --max-events 1`
> form has a buffering/exit-code issue, the dispatch table misses an
> event type the orchestrator depended on, or the legacy event names
> (`checks:passed`, `review:approved`, `pr:merged`) are still emitted by
> a poller we forgot — revert run.md to the prose below as a stopgap
> until the bug is fixed.

## Tracking — original table row (line 158)

```
| Command | Purpose |
|---------|---------|
| `mcx track <issue-number>` | Start tracking (creates work item in `impl` phase) |
| `mcx tracked --json` | List all tracked items with PR/CI/review state |
| `mcx tracked --phase impl` | Filter by phase |
| `mcx untrack <number>` | Stop tracking |
| `mcx claude wait --timeout 30000` | Block until session or work-item event |
```

## Tracking — original event types section (line 172)

```
Poller event types surfaced via `mcx claude wait`:

| Event | Meaning |
|-------|---------|
| `checks:passed` / `checks:failed` | CI outcome |
| `review:approved` / `review:changes_requested` | Review outcome |
| `pr:merged` / `pr:closed` | PR outcome |
```

## Pipeline loop (one tick) — original prose (lines 203–242)

```
## Pipeline loop (one tick)

Per-issue logic is phase-scripted. The orchestrator's loop is:

\`\`\`
while issues remain:
  event = mcx claude wait --timeout 30000 --short
  quota = mcx call _metrics quota_status     # see Quota gating

  for each tracked item:
    # Tick the phase. Do NOT pass --dry-run — it skips the transition log
    # + state writes (provider/model/labels/sessionId), breaking subsequent
    # transitions.
    result = mcx phase run <item.phase> --work-item <item.id>
    case result.action:
      "spawn":     execute result.command (quota permitting), then
                   mcx call _work_items phase_state_set \\
                     '{"workItemId":"<item.id>","repoRoot":"<abs>","key":"session_id","value":"<real-id>"}'
                   (replaces "pending:*"; use the tracked item's actual id —
                    "issue:<n>" or "pr:<n>" — and snake_case state keys:
                    session_id / qa_session_id / review_session_id /
                    repair_session_id, matching the phase the spawn served)
      "in-flight": session running — no action this tick
      "wait":      no action this tick
      "goto":      mcx phase run <result.target> --work-item <item.id>
                   then update work_item.phase = result.target

  for each active session:
    if permission_request: check log, send answer
    if idle with PR pushed (impl): bye + tick current phase again
    if cost > $50: interrupt → bye → file issue

  file issues for any problems observed
\`\`\`

The phase scripts encapsulate what was previously 6-step transition
recipes — e.g. impl→review is now \`mcx phase run triage\` followed by,
when \`result.action == "goto"\`, \`mcx phase run <result.target>
--work-item <item.id>\`. (Triage uses the standard \`action\`/\`target\`
schema since #1832 — no special-cased \`decision\` field.)
```

## Key invariants — original (line 244)

```
**Key invariants** (orchestrator discipline, not enforced by scripts):
- Use `mcx claude wait`, never `sleep`
- `session:result` means idle, not ended
- Don't `bye` before verifying PR pushed
- Don't `bye` a QA session before `qa:pass` / `qa:fail` is on the PR
- Spawn fresh sessions per phase — never reuse across impl/review/QA
- Reuse worktrees across phases via `--cwd` (phase scripts prefer this)
- Never `bye` + respawn to sidestep a stuck session — `send` instead
```

## CWD scoping — original (line 134)

```
**Run all sprint commands from within the project root.** `mcx claude ls`
and `mcx claude wait` filter sessions by the current repo's git root —
use `--all` for cross-repo view.
```

## How to revert (if the new pattern breaks badly mid-sprint-49)

This is a docs/skill revert only — no code changes were involved in the
migration, so revert risk is low.

```bash
# From a fresh meta/<descriptor> branch off main:
git checkout -b meta/revert-run-md-monitor-migration

# The migration commit was e8929c61 on the sprint-48 branch.
# If sprint-48 has merged to main, revert the relevant hunks from the
# squash-merge SHA. If sprint-48 has not merged, revert the commit on
# the sprint-48 branch.

# Surgically restore the four prose blocks above into run.md, leaving the
# new dispatch table content untouched in this file as a reference for
# the eventual fix.

# File a fresh issue with the specific dispatch-table bug + reproduction
# so the new pattern can be re-shipped corrected.
```

The cost of a stopgap revert is one sprint of polling overhead (~60
extra tool calls per turn vs ~1 with stream). The cost of running on a
broken stream pattern is unbounded (silent missed events, work items
stuck in phases the orchestrator never observes). When in doubt, revert
to polling, file the bug, fix, re-migrate.
