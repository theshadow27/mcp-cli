---
name: dont-bye-spikes
description: Never bye investigation/spike sessions until the user explicitly signs off — the context is valuable for follow-up questions
type: feedback
---

Don't bye spike/investigation sessions immediately after they report findings. Leave them idle so the user can ask follow-up questions, request POCs, or dig deeper. The rich context history built during investigation is gold — recreating it is expensive.

**Why:** User wanted to ask follow-up questions about the quota API spike (#1008) findings but the session was already bye'd and the context lost.
**How to apply:** For spike/investigation sessions, report findings to the user and wait for explicit "ok, bye it" before ending. For implementation sessions that create PRs, bye is fine since the work is in the PR.
