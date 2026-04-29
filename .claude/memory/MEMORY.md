# Memory

## User Preferences
- [5-minute prompt cache TTL](user_cache_ttl.md) — cap all blocking waits at 270s (4:30), never ≥ 300s; cache miss re-processes 100k+ tokens at full price
- Don't start bash commands with `# comment` — it triggers manual approval. Use the `description` field instead.
- User prefers concise, no-nonsense communication. Expects issues filed for every problem.
- File issues with actual reproduction data (commands, logs, timestamps). Bare "this happened" issues are useless.
- Diary entries go in `.claude/diary/yyyyMMdd.md` (or `yyyyMMdd.N.md` for sprint N) committed to main.

## Feedback (general — sprint-specific guidance lives in `.claude/skills/sprint/`)
- [Codex retro learnings](feedback_codex_retro.md) — stale binaries, partial branches, protocol drift
- [Git HTTPS push](feedback_git_https_push.md) — when agents get stuck pushing, tell them to use HTTPS
- [Review context in PRs](feedback_review_pr_comments.md) — reviewers post to PR, repairers read PR comments first
- [Open bun.report links](feedback_bun_report.md) — always `open` bun.report URLs to submit crash telemetry
- [Workers are conversations](feedback_worker_interaction.md) — interact via `send`, don't just bye and respawn
- [ScheduleWakeup is blind polling](feedback_schedulewakeup_orchestration.md) — during sprint orchestration use `mcx claude wait`, not ScheduleWakeup
- [Background-task notifications work](feedback_background_task_notify.md) — workers "waiting for notification" is correct; ask duration, don't prescribe polling
- [Don't bye spikes](feedback_dont_bye_spikes.md) — keep exploratory sessions alive for follow-up questions
- [Flaky test handling](feedback_flaky_tests.md) — nerd-snipe BEFORE impl, trail on issue; no root cause + plan = needs-attention, not "spawn opus and hope"
- [Orchestrator context rot](feedback_context_rot.md) — long-running orchestrators degrade at ~300k tokens; verify "done" claims with a probe
- [Bulk reads + serialized cascades](feedback_sprint_bulk_and_cascade.md) — no `for` loops for status (use bulk jq), single-pointer update-branch cascades (avoid N² CI)
- [No gpgsign bypass](feedback_no_gpgsign_bypass.md) — never add `-c commit.gpgsign=false` or similar without explicit ask; only legit orchestrator flag is `SPRINT_OVERRIDE=1`
- [Phase run no --dry-run](feedback_phase_run_no_dry_run.md) — per-tick `mcx phase run <phase> --work-item` without --dry-run; never skip `impl` run (writes transition log + state)
- [Quota end-of-block](feedback_quota_end_of_block.md) — 80% impl-freeze is for early/mid block; near quota reset, fire for effect so long as work won't overrun
- [Claude 2.1.121 sdk-url break](feedback_claude_2_1_121_break.md) — chflags-uchg shim at ~/.local/bin/claude → 2.1.119; archive at ~/.local/share/mcp-cli-archive/; #1808 tracks fix
- [Don't touch parallel #1808 worktrees](feedback_parallel_p1_session.md) — user runs #1808 in a direct claude session; never blanket-prune; don't bye sessions you didn't spawn
- [Verify auto-merge actually fired](feedback_verify_merge_actually_fired.md) — after qa:pass + `gh pr merge --auto`, poll until state=MERGED; QA verdict + auto-merge queue ≠ proof of merge
- [Repair → QA transition](feedback_phase_repair_to_qa.md) — after repair pushes, advance via `phase=qa` write, NOT by re-ticking `mcx phase run repair`; the latter spawns a new repair round

## Orchestration (non-sprint, general facts)
- Orchestrator must never implement directly — always delegate to spawned sessions.
- **Meta files (`.claude/skills/**`, `.claude/memory/**`, `CLAUDE.md`, `.gitignore`) are orchestrator + retro only.** Never spawn a worker to modify them during a sprint. Sprint 32 had two PRs touching `run.md` in parallel and the orchestrator read inconsistent versions for ~20 minutes. Meta changes go through the retro + next-plan workflow.
- Never use `git worktree remove --force` — let the safety check catch uncommitted work.
- `mcx claude ls` and `wait` filter by current repo; use `--all` for cross-repo view.
- Recurring: `core.bare=true` flips mid-operation (#1206/#1243/#1330) — hot-patch with `git config core.bare false` before git ops until sticky fix lands.

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
