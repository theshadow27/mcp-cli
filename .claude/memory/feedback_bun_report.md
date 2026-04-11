---
name: Open bun.report links
description: Always `open` bun.report URLs so Bun gets the crash telemetry
type: feedback
---

When a Bun segfault produces a bun.report link, always run `open <url>` to submit the crash report to Bun's team.

**Why:** Bun uses these reports to prioritize fixes. Just logging the URL without opening it means the crash data never reaches them.

**How to apply:** Any time a bun.report URL appears in test output, CI logs, or session transcripts — `open` it. Also add to CLAUDE.md as a project rule.
