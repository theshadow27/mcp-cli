---
name: Never bypass GPG signing without explicit ask
description: Do not add `-c commit.gpgsign=false`, `--no-gpg-sign`, or similar to git commands unless the user explicitly requests it. Applies to all git commits in this repo and everywhere else.
type: feedback
originSessionId: c643ed85-b89d-40f8-9b5f-9a7efa2566eb
---
Do not add `-c commit.gpgsign=false` (or `--no-gpg-sign`, `--no-verify`, or
any other signing/hook bypass) to `git commit` invocations unless the user
has explicitly asked for it in the current conversation.

**Why:** During sprint 38, I added `-c commit.gpgsign=false` reflexively to
the first orchestrator commit (sprint-start) and then copy-pasted the
pattern through the sprint. The flag wasn't coming from any sprint skill,
CLAUDE.md, memory, or a user request — I just added it. User called it
out during retro: *"Where did that pattern come from?"* The only legitimate
orchestrator-commit flag is `SPRINT_OVERRIDE=1`, which is documented in
`run.md` and `retro.md` to bypass the `.claude/sprints/.active`
pre-commit guard (issue #1443).

The bypass flag was also harmless in this case because no signing key is
configured locally — but it was still the wrong instinct, and if signing
*is* configured later, suppressing it silently is worse than letting it
fail and asking the user how to proceed.

**How to apply:** When writing `git commit` commands in orchestrator /
skill flows, use `SPRINT_OVERRIDE=1 git commit -m "..."` — nothing else.
If a pre-commit hook fails (signing, lint, test), investigate the root
cause or ask the user; don't reach for a bypass flag.
