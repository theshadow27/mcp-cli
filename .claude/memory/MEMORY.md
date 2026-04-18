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
- [Flaky test handling](feedback_flaky_tests.md) — root-cause fixes, not timeout increases
- [Orchestrator context rot](feedback_context_rot.md) — long-running orchestrators degrade at ~300k tokens; verify "done" claims with a probe
- [Bulk reads + serialized cascades](feedback_sprint_bulk_and_cascade.md) — no `for` loops for status (use bulk jq), single-pointer update-branch cascades (avoid N² CI)

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
- Branch protection enabled on `main`: `check`/`coverage`/`build` required, auto-merge enabled.
