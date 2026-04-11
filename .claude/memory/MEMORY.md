# Memory

## User Preferences
- Don't start bash commands with `# comment` — it triggers manual approval. Use the `description` field instead.
- Orchestrator must never implement directly — always delegate to spawned sessions.
- User prefers concise, no-nonsense communication. Expects issues filed for every problem.
- Never use `git worktree remove --force` — let the safety check catch uncommitted work.
- File issues with actual reproduction data (commands, logs, timestamps). Bare "this happened" issues are useless.
- Diary entries go in `.claude/diary/yyyyMMdd.md` committed to main. Multiple entries per day OK (e.g. `20260311.1.md`).
- Always keep ≥3 implementation threads going. Don't idle on one session — saturate the queue.

## Feedback
- [Codex retro learnings](feedback_codex_retro.md) — stale binaries, partial branches, protocol drift
- [Git HTTPS push](feedback_git_https_push.md) — when agents get stuck pushing, tell them to use HTTPS
- [Review context in PRs](feedback_review_pr_comments.md) — reviewers post to PR, repairers read PR comments first
- [Open bun.report links](feedback_bun_report.md) — always `open` bun.report URLs to submit crash telemetry
- [Workers are conversations](feedback_worker_interaction.md) — interact via `send`, don't just bye and respawn

## Orchestration Patterns
- Use `mcx claude wait --timeout 30000` instead of sleep polling — sleep is uninterruptible.
- `session:result` from `wait` means **idle** (waiting for input), NOT ended. Check state before deciding to `bye` or `send`.
- Pipeline: implement → triage → [low: QA] or [high: adversarial-review → repair → QA].
- **Two adversarial reviews for rewrites** — second round catches issues introduced by first-round fixes.
- Adversarial review on sonnet is fine and cheaper. Implementation always on opus.
- **5+5 slot model**: 5 opus implementation slots + unlimited sonnet review/QA slots.
- `mcx claude ls --short` and `wait --short` for compact monitoring output.
- Triage: `bun .claude/skills/estimate/triage.ts --pr N --json` for PR-based triage.
- Don't `bye` a session before verifying the PR was pushed.
- Spawn fresh sessions per phase — don't reuse across implement/review/QA.
- Use compiled binaries. Run `bun run build` after merging CLI changes.
- **Don't bulk-clean worktrees during a sprint** — check `mcx claude ls` first.
- **Don't restart daemon mid-batch** — wait for active sessions to idle.
- **Restart daemon after `bun run build`** if daemon code changed — stale daemon won't have new fixes. Do this at sprint start (pre-flight) and after wind-down rebuild.
- **Always use `--worktree` for QA/review sessions** — `bye` auto-cleans implementation worktrees, so `--cwd` won't work. Never spawn QA/review without isolation.

## Release Process
- No auto-versioning. Releases are intentional at sprint boundaries via `/release`.
- Diary = retro (what worked, what didn't, patterns). Release notes = user-facing changelog.
- Tag push triggers Release workflow (cross-platform binary builds + GitHub Release).
- Deleted `version.yml` (was broken: re-created v0.2.0 on every push to main).

## Next Sprint (16)
- **#697**: Auto-promote ephemeral aliases (deferred from Sprint 15, depends on #696 which is now merged)
- **#812**: Replace test time budget with hash-based timing cache (P1 — caused $2700 waste in Sprint 15)
- **jq in `mcx serve`**: Customer-filed issue — see [project_jq_serve_issue.md](project_jq_serve_issue.md)
- **ACP/OpenCode spikes**: #518, #503 (need validation before impl)

## Completed (Sprint 15, 2026-03-17 — 14 PRs)
- Ephemeral aliases #696 (2 adversarial reviews, 2 repair rounds, PR #800)
- Plans tab stabilization: #775, #778, #763, #762, #780, #783, #782, #779
- Serve/DX: #764, #787, #788
- Infra: #789 (pre-commit optimization), #784 (double-fire guard)

## Completed (Sprint 14, 2026-03-16 — 14 PRs)
- P1 serve bug #754, plans tab features #705/#706/#707, verbose/dry-run #90

## Skills
- `/sprint` — survey board, pick issues, run full pipeline. Sprint files include timestamps.
- `/board-overview` — survey only, writes `.claude/arcs.md`
- `/diary` — backfill diary entries from session transcripts (supports multiple per day)
- `/release` — intentional release: read changes, determine semver, write notes, tag, push
- `/flaky-tests` — mine session transcripts for test failures across sessions

## Project Conventions
- `mcx claude` commands: spawn, resume, ls, send, bye, log, wait, interrupt, worktrees
- Worktrees go in `.claude/worktrees/`
- Pre-commit hook runs typecheck + lint + test + coverage check (timing budget is warn-only, see #812)
- `bun dev:mcx --` for running CLI in dev mode
