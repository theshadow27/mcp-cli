---
name: flaky test fix policy (pointer to canonical reference)
description: Flaky / CI-instability / recurring issues need a nerd-snipe investigation BEFORE impl. Canonical rule lives in repo at .claude/skills/sprint/references/investigations.md (load-bearing); this memory is a stub pointer.
type: feedback
originSessionId: 484a037b-9f1e-468c-aa12-32fd92da0c26
---
The full rule (when to apply, spawn shape, hard gate, post-gate flow)
lives in the **repo**, not in user memory:

→ `.claude/skills/sprint/references/investigations.md`

Why this is a stub: load-bearing sprint rules need to be in the repo so
every Claude session working on this project sees the same rule. User
memory is per-user and not committed.

Quick summary for context:

- Flaky / recurring / unclear-mechanism issues require a nerd-snipe pass
  BEFORE phase=impl (sprint 47 / #1870 incident motivated the rule).
- **Spawn via `mcx claude spawn`** with persona inlined in the prompt.
  Do NOT use `Agent({subagent_type: "nerd-snipe"})` — that creates a
  sub-context the orchestrator can't see (sprint 52 / #1980 / #1987
  incident, tracked as #2009).
- Worker posts findings as a GitHub issue comment (timeline + bisect +
  mechanism + concrete fix plan).
- Hard gate: no root cause + fix → `needs-attention`, never spawn impl
  on hope.
