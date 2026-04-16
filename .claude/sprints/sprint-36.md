# Sprint 36

> Planned 2026-04-16. Demo scheduled 2026-04-17.
> Target: 8 PRs + 1 investigation. Customer issues + pipeline polish.

## Goal

**First sprint run entirely through the validated phase pipeline.**
v1.5.1 landed `mcx phase run` with real handler execution; sprint 35
proved it works end-to-end. Sprint 36 uses it as the default flow —
no Stage A/B/C gating, no legacy spawns, no re-plans.

Secondary goal: ship **5 customer-reported issues** (#1410–#1414) that
were the lead-up to this demo, and clean up 3 orchestrator DX papercuts
surfaced last sprint (#1424, #1425, #1426).

## Demo notes (2026-04-17)

This sprint is scheduled to run during a work demo. Plan accordingly:

- **Lead with Batch 1 during the demo.** Customer issues are the best
  story: real reporters, real repros, fast wins.
- **Pipeline visibility.** Live-narrate `mcx phase run impl --work-item
  "#N"` → JSON → `mcx claude spawn` → `mcx phase run triage` → `qa`
  → `done`. Each transition is a 1-line call with structured output —
  good screen time.
- **Don't demo #1397 (merge-queue) or #1286 (full in-handler autonomy).**
  Both are in flight but not ready for live viewing. Keep them off the
  slides.
- **Have a rollback plan.** If something misbehaves during the demo,
  pause the sprint, show the retro + v1.5.1 release notes, and point
  at what's already working. Sprint-35's `saved/*` branches + re-plan
  are also demonstrable artifacts if the live run breaks.

## Pre-flight acknowledgements

Sprint 35 landed a lot. Confirm the following BEFORE starting sprint 36:

- [x] v1.5.1 built and released
- [x] `mcx phase run <name> --dry-run --work-item "#N"` prints handler
      JSON on stdout (not just transition validator)
- [x] `mcx phase run <name> --work-item "#N"` (real) executes the
      handler and persists state via daemon
- [x] **Sprint-35 worker-direct commits on main — DECISION: keep both.**
      `d1910cfd` (permissions test fixture: replace hardcoded
      `jacob-dilles` with generic `user` slug) and `7c8bafcf` (path-pattern
      privacy guard on `.git-hooks/pre-commit`). The fixture fix makes
      the permissions test suite portable across developer machines —
      demo-critical for sprint 36. The privacy hook is a benign safety
      mechanism that has never blocked a legitimate commit. Both live
      on main. Backup branches (`saved/*`) deleted. Direct-push
      provenance is captured in sprint-35 retro.

## Portability context (fresh-machine demo)

The demo runs on a different computer that **will not** have this
orchestrator's auto-memory (`~/.claude/projects/.../memory/`).
Everything a fresh orchestrator needs is below or in the repo's
`.claude/skills/sprint/` + `CLAUDE.md`.

### Critical rules baked into skill files (trust them)

These are already in `.claude/skills/sprint/references/`:

- **Cache TTL** (`run.md`): wait timeouts ≤ 270000ms to stay inside
  5-min prompt-cache. `mcx claude wait --timeout 270000 --short` is
  the event loop.
- **Phantom commit check** (`run.md` pre-flight): `git log HEAD
  ^origin/main --oneline` must be empty before starting. Non-empty =
  worker escaped its worktree.
- **Bye discipline** (`run.md`): end impl session only after PR merged
  OR (qa:pass + 0 open threads on 4 comment surfaces + CI green).
- **Work item branch field** (`run.md`): `work_items_update` does NOT
  auto-populate `branch` from `prNumber` (see #1424); set both.
- **Release cut is non-atomic** (`review.md`): `bun lint` + `bun
  typecheck` BEFORE `git commit`; tag only after commit verified.
- **`disconnected` sessions** (`mcx-claude.md`): immediate `bye` — they
  silently burn tokens (#1426 saw 111k-token leak).

### Repo-level rules in `CLAUDE.md`

- Meta files (`.claude/skills/**`, `.claude/memory/**`, `CLAUDE.md`,
  `.gitignore`) are orchestrator + retro only. Workers never touch
  them during a sprint.
- `core.bare=true` recurrence: hotpatch with `git config core.bare
  false` before git ops if you see strange worktree errors (#1206/
  #1243/#1330).
- Bun segfaults: append to #1004 with bun.report URL, and always
  `open` the URL so telemetry reaches Bun's team.
- Never use `git worktree remove --force` — let the safety check catch
  uncommitted work.

### Repo state at sprint-36 kickoff

```
main:    01057eaf (sprint-36 plan + skill fixes committed)
tag:     v1.5.1 — https://github.com/theshadow27/mcp-cli/releases/tag/v1.5.1
worktrees: only repo root, /private/tmp/mcp-cli-pre1389 (prior sprint
           artifact, leave alone), .claude/worktrees/repair-1342-branch
           (prior sprint, leave alone)
saved/ branches: deleted (direct commits decided as KEEP)
tracked work items: none (cleared during wind-down)
daemon: restart required — see "First command after fresh clone" below
```

### First commands after fresh clone on demo machine

```bash
git clone <repo> mcp-cli && cd mcp-cli
bun install                               # deps
bun run build                             # dist/mcpd, dist/mcx, dist/mcpctl
# Add dist/ to PATH OR use `bun dev:mcx --` for dev mode
mcx status                                # starts daemon
mcx phase install                         # resolve .mcx.yaml → .mcx.lock
gh auth status                            # must be authenticated
mcx call _metrics quota_status            # check headroom (≥80% → impl freeze)
git fetch origin main \
  && git log HEAD ^origin/main --oneline  # phantom-commit pre-flight (MUST be empty)
```

### If the demo machine's credentials differ

- Git user: workers will commit with `git config user.email/name` on
  the demo machine. That's fine — release commits carry the
  co-author line. Do NOT run `git config --global` — honor whatever
  the user's local config is.
- GitHub auth: `gh auth login` with a token scoped to the repo.
  Admin bypass on branch protection is orchestrator-only and may or
  may not be available on the demo account — if not, meta commits
  must go through PR (this is the desired state anyway).

## Meta items (orchestrator-applied, NOT sprint work items)

1. **Audit sprint skill files after sprint-36 runs.** `run.md`, `review.md`,
   `mcx-claude.md` just got sprint-35-retro patches. Some entries cite
   sprint-35 specifics (issue numbers, token counts) that will age
   poorly. Post-sprint: trim the historical asides, keep the rules.
   User asked for this explicitly during retro.
2. **Follow up on #1425 (worker-direct commits).** Not a sprint item,
   but the orchestrator must track whether it recurs. Pre-flight
   phantom-commit check is now in `run.md`; that's the immediate
   mitigation.
3. **Follow up on #1426 (disconnected sessions).** Daemon-side fix;
   needs a dedicated investigation, not sprint work. Orchestrator
   should `bye` any `disconnected` session immediately per updated
   `mcx-claude.md`.
4. **Carried from sprint 35:** `--no-verify` settings hook, branch ruleset
   `required_review_thread_resolution`, `enforce_admins` decision. All
   user-call.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| **1410** | **fix(alias): mcx run defineAlias fails — bundled `export` not stripped** | **medium** | **1** | **opus** | **customer bug** |
| **1411** | **fix(alias): mcx alias save defineAlias validation fails — subprocess starts daemon** | **medium** | **1** | **opus** | **customer bug (related to #1410)** |
| **1412** | **dx(import): `mcx import` with no args should also try `~/.claude.json`** | **low** | **1** | **sonnet** | **customer DX enhancement** |
| **1413** | **fix(compat): `Bun.sliceAnsi` crashes `mcx ls <server>` on Bun < 1.2.18** | **low** | **1** | **sonnet** | **customer compat bug** |
| **1414** | **investigate(jq): `mcx call --jq` reports JSON parse error on HTTP-transport responses** | **medium** | **1** | **opus** | **customer investigation (may not produce a PR)** |
| **1424** | fix(phase): triage error should say which field is missing, auto-populate branch from prNumber | medium | 2 | opus | sprint-35 DX follow-up |
| 1397 | feat(merge-queue): local deterministic merge-queue service | high | 3 | opus | sprint-34 retro insight; depends on #1381 (✅) |
| 1367 | repro harness: gh pr merge --delete-branch → core.bare=true | medium | 2 | opus | proves #1330 sticky fix |
| 1372 | bug(phases): O_EXCL lockfile not atomic on NFS | medium | 3 | opus | #1328 follow-up |
| 1392 | rapid codex worker respawn may hit Bun module-resolution race | medium | 3 | opus | DX P2 |

**Excluded (phase-pipeline polish sprint candidates for 37):** #1350
(dead stubState), #1313 (wire parseSource into install), #1344 (cycle
detection), #1343 (installedAt field), #1351 (validate initialPhase),
#1352 (orphan transition rows), #1353 (workItemResolver timeout),
#1370 (loadManifest ENOENT race), #1375 (transitions.jsonl rotation),
#1385 (truncate forceMessage), #1386 (combined --json+--work-item test),
#1391 (assertNoDrift CI).

## Batch Plan

### Batch 1 — Customer issues (demo slot)
#1410, #1411, #1412, #1413, #1414

- **#1410 + #1411** are paired — same file area (alias system), same
  reporter. Spawn sequentially (not parallel) — likely shared root cause.
  Demo angle: "customer reported two bugs; one impl session fixes both."
- **#1412** is a sonnet-sized DX polish. Good first-merge during demo.
- **#1413** is a compat one-liner (replace `Bun.sliceAnsi` with
  portable equivalent). Quick win.
- **#1414** is marked `investigate` because the author couldn't locally
  reproduce. If the impl session can't repro either, it closes with a
  diagnosis comment (not a PR). Demo angle: "the pipeline handles
  no-PR outcomes too — routes to `needs-attention`."

### Batch 2 — DX + sprint-35 follow-ups
#1424, #1367

- **#1424** directly addresses the papercut the orchestrator hit 3–4
  times last sprint. Auto-populate `branch` on `work_items_update` from
  `prNumber`; improve error message.
- **#1367** is the repro harness proving #1330's sticky `core.bare=true`
  fix actually works under real `gh pr merge` conditions. Cheap.

### Batch 3 — Medium/high scrutiny (only if 1+2 are healthy)
#1397, #1372, #1392

- **#1397** is the merge-queue service — retires the LLM mergemaster
  for the common case. Full-batch cook. Don't demo.
- **#1372** (NFS O_EXCL) is edge-case but worth filing while code is
  fresh.
- **#1392** (Bun module race) is production-adjacent.

## Pipeline flow (this sprint only)

Use the validated flow from sprint-35 Stage B for every issue:

```bash
mcx track $N
PR=<after impl runs>
BRANCH=$(gh pr view $PR --json headRefName -q .headRefName)
mcx call _work_items work_items_update "{\"id\":\"#$N\",\"prNumber\":$PR,\"branch\":\"$BRANCH\"}"
mcx phase run triage --work-item "#$N"              # → decision: review or qa
mcx phase run <decision> --work-item "#$N"          # spawn
# ... wait for transcripts + CI ...
mcx phase run <decision> --work-item "#$N"          # re-enter: read verdict
mcx phase run <next> --work-item "#$N"              # qa or repair
mcx phase run done --work-item "#$N"                # merge
```

**Note on autonomy level:** `mcx phase run` emits spawn descriptors as
JSON; the orchestrator still pipes + executes them. Fully in-handler
spawning is tracked in #1286 (not in sprint 36).

## Dependency graph

```
  #1410 ── paired with #1411 (same alias subsystem) — sequential
  #1411 ── depends on #1410 outcome (likely shared fix)
  #1412 ── independent
  #1413 ── independent
  #1414 ── independent, investigation-only (may not merge a PR)

  #1424 ── depends on #1381 (✅ landed) — uses work_items_update
  #1367 ── depends on #1330 (✅ landed)
  #1397 ── depends on #1381 (✅ landed)
  #1372, #1392 ── independent
```

## Risks

- **Demo-time regression.** If something breaks live, pipe the retro +
  v1.5.1 notes instead. Sprint-35's `saved/*` branches are also a good
  "here's what containment looks like" story.
- **#1410/#1411 shared root cause may be larger than estimated.** If
  the impl session discovers a deeper alias-subsystem issue, pivot to
  filing sub-issues rather than expanding scope.
- **#1414 may resolve to "can't repro."** That's a legitimate
  outcome — document in comments, route to `needs-attention` via the
  phase pipeline, don't force a PR.
- **Sprint-35 retro nudges are fresh.** `run.md`, `review.md`,
  `mcx-claude.md` each got edits within the last 12 hours. Any
  contradictions will surface during execution — mitigate by running
  from the updated skill files and filing a bug + hot-patch (not a
  re-plan) if something is wrong.
- **Worker containment** (#1425 recurrence): the pre-flight
  phantom-commit check now catches this at start of sprint, not at
  release time. Still a risk during execution if a worker escapes its
  worktree mid-sprint — run the check between batches.

## Success criteria

- **Primary:** all 5 customer issues closed (4 PRs + 1 investigation
  verdict). Demo goes cleanly.
- **Secondary:** #1424 landed (removes the orchestrator papercut), no
  phantom commits on main, no `disconnected`-session token-leak
  incidents.
- **Stretch:** #1397 landed (merge-queue retires LLM mergemaster for
  the common path), batches 2+3 complete.

## Stretch (only if everything is going great)

- Pull a phase-pipeline polish issue from the excluded list above
  (e.g. #1350, #1344).
- File sprint-37 candidate: "phase-pipeline polish sprint" grouping
  the 12 deferred issues.
