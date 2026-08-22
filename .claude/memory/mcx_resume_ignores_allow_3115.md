---
name: mcx-resume-ignores-allow-3115
description: mcx claude spawn --resume silently discards --allow; respawn instead of resuming an under-permissioned session
metadata:
  type: reference
---

`mcx claude spawn --resume <id> --allow <tools...>` **silently ignores `--allow`**. The resumed session keeps whatever allowlist it was created with, the caller gets a normal `{sessionId, seq}` response with no warning, and the session cannot introspect its own effective allowlist — it can only discover the truth by probing commands and reading "This command requires approval". Tracked as **#3115** (filed 2026-08-22, mcx 1.14.6).

A session spawned with **no** `--allow` gets a narrow read-only set (`git log/rev-list/diff/status`, `ls`, `find`, `grep`, `which`, `uptime`) — `gh`, `bun`, `git fetch/rebase/add/commit/push` and even `echo` are all denied.

**How to apply:** always pass `--allow Read Glob Grep Write Edit Bash` on the *initial* spawn (bare `Bash` does grant arbitrary commands — verified by probe). If a session turns out to be under-permissioned, **respawn it**; resuming with `--allow` will not fix it and costs a round. `.claude/phases/impl.ts` already passes an explicit allowlist, so phase-spawned sessions are fine — this only bites hand-rolled `mcx claude spawn` calls.
