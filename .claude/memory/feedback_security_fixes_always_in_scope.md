---
name: feedback-security-fixes-always-in-scope
description: Security fixes are always authorized — they do not consume the 2-per-sprint QoL budget
metadata:
  type: feedback
---

Operator, 2026-08-22: *"you can always do security fixes."*

Security work is **not** part of the two-per-sprint quality-of-life budget
([[feedback-qol-budget-per-sprint]]). Slot it when it is needed, in addition to the QoL
picks, without asking.

**Why:** the QoL cap exists to keep a six-sprint arc from drifting into general backlog
cleanup. A security gap is not backlog — deferring it means shipping the arc on top of it,
and the whole point of landing trust (epic C) early is that provenance and containment
cannot be retrofitted.

## Permission modes — operator's read

*"the auto permission mode is pretty darn good, it can keep an agent in check. only the
approve and dangerous modes are problematic."*

So the preferred posture for a contained/unattended session is **Claude Code's auto mode**,
whose two-stage classifier (`allow` / `soft_deny` / `hard_deny` — see `docs/trust.md`)
does real gating. **Approve** cannot work unattended; **dangerous**
(`--dangerously-skip-permissions`) removes gating entirely.

Do not "fix" a containment gap by **denying `Bash`** — that forces every command through a
daemon round-trip and duplicates gating a good mode already provides. Prefer choosing the
right mode and treating `ContainmentGuard` as a second layer. See #3117.

**Name collision to watch:** mcx's own `PermissionStrategy` has a value `auto` that means
**allow-everything** (`permission-router.ts:48`), which is nearly the opposite of Claude
Code's auto mode. Do not conflate them when reading config or writing a brief.

As of 2026-08-22 mcx spawns workers with `--permission-mode default` and never passes
`--dangerously-skip-permissions`. Related: [[project-domain-scoped-mcx-3019]].
