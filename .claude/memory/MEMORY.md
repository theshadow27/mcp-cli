# Memory

## User Preferences
- [5-minute prompt cache TTL](user_cache_ttl.md) — cap all blocking waits at 270s (4:30), never ≥ 300s; cache miss re-processes 100k+ tokens at full price
- Don't start bash commands with `# comment` — it triggers manual approval. Use the `description` field instead.
- User prefers concise, no-nonsense communication. Expects issues filed for every problem.
- File issues with actual reproduction data (commands, logs, timestamps). Bare "this happened" issues are useless.
- Diary entries go in `.claude/diary/yyyyMMdd.md` (or `yyyyMMdd.N.md` for sprint N) committed to main.

## Feedback (general — sprint-specific guidance lives in `.claude/skills/sprint/`)
- [Codex retro learnings](feedback_codex_retro.md) — stale binaries, partial branches, protocol drift
- [Codex broken (#2482)](codex_broken_2482.md) — codex spawn fully broken (RPC -32600) as of sprint 66; don't route to codex, use opus
- [Git HTTPS push](feedback_git_https_push.md) — when agents get stuck pushing, tell them to use HTTPS
- [Wait on the monitor stream, not ScheduleWakeup](feedback_schedulewakeup_orchestration.md) — ScheduleWakeup is blind fixed-delay polling; wait on the `mcx monitor` event stream (default) and use its `heartbeat` event to observe wall-time + catch a silent worker; ScheduleWakeup only for idle quota-pause-to-`resetsAt`
- [Background-task notifications work](feedback_background_task_notify.md) — workers "waiting for notification" is correct; ask duration, don't prescribe polling
- [Don't bye spikes](feedback_dont_bye_spikes.md) — keep exploratory sessions alive for follow-up questions
- [Orchestrator context rot](feedback_context_rot.md) — long-running orchestrators degrade at ~300k tokens; verify "done" claims with a probe
- [Verify investigation hypotheses](feedback_verify_investigation_hypothesis.md) — reproduce a prescribed root cause before implementing the fix; if it doesn't reproduce, fix the real cause + report the discrepancy with evidence (don't cargo-cult the named file)
- [Bulk reads + serialized cascades](feedback_sprint_bulk_and_cascade.md) — no `for` loops for status (use bulk jq), single-pointer update-branch cascades (avoid N² CI)
- [No gpgsign bypass](feedback_no_gpgsign_bypass.md) — never add `-c commit.gpgsign=false` or similar without explicit ask; only legit orchestrator flag is `SPRINT_OVERRIDE=1`
- [Verify auto-merge actually fired](feedback_verify_merge_actually_fired.md) — after qa:pass + `gh pr merge --auto`, poll until state=MERGED; QA verdict + auto-merge queue ≠ proof of merge
- [Repair → QA transition](feedback_phase_repair_to_qa.md) — after repair pushes, advance via `phase=qa` write, NOT by re-ticking `mcx phase run repair`; the latter spawns a new repair round
- [No rebase of sprint branch](feedback_no_rebase_sprint_branch.md) — sprint-{N} branch is meta-only and main is strict=false; commit on top, never rebase to "catch up" (sprint 59 startup fumble)
- [Agent briefs run full gate](feedback_agent_briefs_full_gate.md) — tell code-editing agents to run `bun run am-i-done`, not a subset; enumerate ALL packages when partitioning (#2344 missed codex)
- [Trust gate exit code](feedback_trust_gate_exit_code.md) — check clean/dirty via exit code, not a grep of output (plural-only grep missed "1 violation", #2344)
- [Don't end on passive wait](feedback_dont_end_on_passive_wait.md) — never terminate a turn on Monitor/wait when the producer might be dead; ~400k cache-miss possible
- [Quota status staleness](feedback_quota_status_staleness.md) — `quota_status` can be frozen (check `fetchedAt` + `lastError`); `[RATE LIMITED]` is soft backpressure, not a hard block; frozen utilization:100 ≠ true exhaustion
- [Foreground am-i-done to unstick rate-limited worker](feedback_foreground_am_i_done_unstick.md) — worker stuck re-launching am-i-done as a background task loops under throttle; interrupt and run a blocking foreground Bash call with ~120s timeout instead
- [Meta-issue planning guard](feedback_meta_issue_planning_guard.md) — exclude issues whose surface is .claude/phases/**, .mcx.yaml, or .claude/skills/** at plan time (meta; sprint-74 note: #2804 merged with a reload-after-merge protocol but cost 3 lock rounds via #2737)
- [Never bypass gates (--no-verify banned)](feedback_never_bypass_gate.md) — push blocked by a flake → retry (never --no-verify); same tracked signature → wait + retry once more; NEW signature → stop and report. CI on clean runners is the arbiter

## Infra / Known Issues
- [CPU wedge: bun test-workers](cpu-wedge-test-workers.md) — ⚠️ CORRECTED: the band-aid killers (orphan-sweep preload + watchdog #2597 + cap #2632) WERE the disease, reverted in #2637. No real leak: clean main runs coverage in ~45s. Rule: never fix a leak with a process killer / host-wide `ps`+kill. See retro `.claude/diary/20260530.70.md`
- [Early segfault = check host load first](false-segfault-orphaned-load.md) — am-i-done aborting ~25-30s with a Bun segfault + mass `worker panicked` cascade is usually host CPU starvation (orphaned `bun build/burn.ts` from investigations), not a code bug; check `uptime` + PPID=1 bun procs before treating as real
- [CI suite SIGTERM at ~97%](ci-suite-sigterm-resource-leak.md) — large `bun test` killed near end with 0 failures, Linux-only, passes isolated = resource leak in test files, NOT a size threshold. A hang / near-end SIGTERM is a STOP-and-fix-root-cause signal — never a killer/reaper/timeout-bump (those caused the 69/70 collapse). Diagnose with bias-free adversarial review. #2641→#2644.

## Orchestration (non-sprint, general facts)
- Orchestrator must never implement directly — always delegate to spawned sessions.
- **Meta files (`.claude/skills/**`, `.claude/memory/**`, `CLAUDE.md`, `.gitignore`) are orchestrator + retro only.** Never spawn a worker to modify them during a sprint. Sprint 32 had two PRs touching `run.md` in parallel and the orchestrator read inconsistent versions for ~20 minutes. Meta changes go through the retro + next-plan workflow.
- Never use `git worktree remove --force` — let the safety check catch uncommitted work.
- `mcx claude ls` and `wait` filter by current repo; use `--all` for cross-repo view.
- `core.bare` arc closed in sprint 52 / #1860 / PR #1998 — `ensureCoreBareUnset()` removes the key entirely; daemon sweep deletes both true/false. Pre-flight invariant: `git config --local core.bare` should exit non-zero (key absent). The `git config core.bare false` hot-patch is no longer needed.
- [Sprint operator north-star](project_sprint_operator.md) — orchestrator as k8s-style reconciler; backlog as declarative CRD (`mcx flow apply`); crash-resume = stateless reconcile; moat is the control plane not the LLM. Epic #2577. Near-term: Stage 0 review-labels + Stage 1 reconciler (#1942).
- [Remote agent orchestration via sprite](project_sprites_remote_orchestration.md) — `mcx agent claude` subcommands work over `sprite x --` remote exec; stdout JSON + exit codes + no-TTY constraints must be preserved when changing the agent command surface

## Skills
- `/sprint` — lifecycle: plan, run, review, retro. Detailed rules in `.claude/skills/sprint/references/*.md`.
- `/board-overview` — survey only, writes `.claude/arcs.md`
- `/diary` — backfill diary entries from session transcripts
- `/release` — intentional release: read changes, determine semver, write notes, tag, push
- `/flaky-tests` — mine session transcripts for test failures across sessions
- `/bootstrap-sprint` — build sprint skill for a new project; cross-sprint lessons in `.claude/skills/bootstrap-sprint/references/lessons.md`

## Project Conventions
- `mcx claude` commands: spawn, resume, ls, send, bye, log, wait, interrupt, worktrees
- Worktrees go in `.claude/worktrees/`
- Pre-commit hook: typecheck + lint + test + coverage (timing budget warn-only, see #812)
- `bun dev:mcx --` for running CLI in dev mode
- Release process: no auto-versioning. Intentional at sprint boundaries via `/release`. Tag push triggers Release workflow. Diary = retro (internal). Release notes = changelog (user-facing).
- Branch protection on `main`: `check`/`coverage`/`build` required, auto-merge enabled. As of sprint 38, `strict_required_status_checks_policy: false` (ruleset 13509324) — branches do NOT need to be up-to-date. Merge order is orchestrator's responsibility; main-CI is the gate.
