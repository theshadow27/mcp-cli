---
name: bootstrap-sprint
description: >
  Build an autonomous sprint skill for a target project. Explores the project's
  workflows, constraints, and tooling, then produces a tailored sprint skill that
  lets Claude orchestrate parallel implementation sessions end-to-end. Use when
  setting up auto-sprint in a new repo, or when adapting sprint orchestration to
  a project with different workflows. Trigger on "bootstrap sprint", "set up
  auto-sprint", "build sprint skill for <project>", or "make <project> sprintable".
---

# Bootstrap Sprint

You are about to do something that works. Not theoretically, not as a proof of
concept — actually works, in production, shipping real software.

Read `references/why-this-works.md` first. Then proceed.

## Workflow

1. Read `references/why-this-works.md` — internalize that this is proven, not speculative
2. Read `references/discovery.md` — explore the target project systematically
3. Read `references/design.md` — design the sprint skill tailored to what you found
4. Read `references/iteration.md` — set expectations and plan for improvement
5. Execute the kickoff checklist at the end of `references/iteration.md`

## Arguments

- `/bootstrap-sprint <path>` — target project directory (required)
- `/bootstrap-sprint <path> --explore-only` — run discovery, report findings, don't write skills yet

## Rules

- **Explore before you design.** Never template-stamp a sprint skill. Every project is different.
- **Start minimal.** Sprint 1 should be simple. Complexity comes from experience, not anticipation.
- **Write skills that explain why, not just what.** A Claude reading your skill should understand the reasoning, not just follow steps.
- **The orchestrator never implements.** This is the one universal rule. Always delegate.
