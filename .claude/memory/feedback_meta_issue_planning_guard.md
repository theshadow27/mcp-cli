---
name: feedback_meta_issue_planning_guard
description: exclude issues whose surface is .claude/phases/**, .mcx.yaml, or .claude/skills/** at plan time — they're meta, unmergeable mid-sprint
metadata:
  type: feedback
---

An issue is **meta** (orchestrator-only, unmergeable during a sprint) if its implementation surface is `.claude/phases/**`, `.mcx.yaml`, `.claude/skills/**`, `.claude/memory/**`, or `CLAUDE.md` — the files the orchestrator reads/runs live on every tick. These must be excluded at `/sprint plan` time, not discovered at PR time.

Watch for innocuous-sounding descriptions that actually land in these files. "Add X to the impl/review **prompts**" sounds like a worker-prompt edit (`.claude/commands/*.md`, which IS worker-editable) but the spawn prompts are *built by* `.claude/phases/impl.ts`/`review-fn.ts` — so the real change is a phase-script edit = meta.

**Why:** Sprint 68 let #2331 ("add `mcx pr comments resolve` to impl/review prompts") through as a filler. The worker correctly implemented it in `.claude/phases/*.ts`, producing a PR (#2570) that can't merge mid-sprint (the orchestrator runs those phase scripts live). Wasted a worker slot; had to park the PR and relabel `meta`.

**How to apply:** In `/sprint plan`, before adding any issue, ask "what files does this touch?" If the answer includes a meta path, tag it `meta` and put it in the Excluded section — it goes through the retro/next-plan meta workflow, never a mid-sprint worker PR. When in doubt about "prompts," check whether it's `.claude/commands/*.md` (worker-editable) vs `.claude/phases/*.ts` (meta).
