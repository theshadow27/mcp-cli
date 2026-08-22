---
name: feedback-worker-escape-hatch
description: Every spawned worker brief must include a way to report being blocked — mcx mail to `boss`, or a direct agent message
metadata:
  type: feedback
---

**Every brief for a spawned session must include an escape hatch**, and the supervising
session must watch for it.

```
echo "what is blocking me, what I tried, what I need" | mcx mail -s "blocked: <one line>" boss
```

`mcx mail` recipients are plain role-names (`boss`, `orchestrator`, `reviewer`), mailboxes
are created implicitly on first send, and `mcx mail -u boss -H` lists headers. Poll that in
the deck-watch monitor and emit each new header. It works as long as bash works, which makes
it the robust channel.

Second channel: current Claude harnesses support **direct agent-to-agent messaging** between
sessions in the same permission mode (auto). `ListAgents` shows every live mcx-spawned
session as an addressable peer by name, and `SendMessage` reaches them. Less reliable than
mail as a hatch — a session wedged behind a classifier may not manage a tool call — so offer
both and prefer mail.

**Why:** a worker blocked behind a permission or classifier denial looks *exactly* like a
worker thinking hard. Both are quiet. That ambiguity is this project's most expensive failure
mode — sprint 77 sat stopped for nineteen days on it. A message converts a silence into a
signal.

**Wording matters.** Say explicitly that using it carries no penalty and that a false alarm
is cheap, otherwise a worker optimising for looking competent will stay quiet and grind. The
line that works: *"Being stuck quietly is the only wrong answer."*

Especially important once workers run under `--permission-mode auto` (#3119), where a
`soft_deny` can block an unattended worker with no human to clear it.

Related: [[feedback-send-briefs-via-file]], [[feedback-dont-end-on-passive-wait]],
[[project-domain-scoped-mcx-3019]].
