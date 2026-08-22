---
name: project-bedrock-spawns-935
description: Bedrock for mcx claude spawns — issue
metadata: 
  node_type: memory
  type: project
  originSessionId: edbafd85-70a1-4903-a1b0-46b69a5a179b
---

Routing `mcx claude` / `mcx agent claude` spawns to Bedrock (unmetered, vs company-capped Anthropic extra usage) is tracked in **#935** (profiles / `--profile` + `~/.mcp-cli/profiles/`); fresh data point added 2026-07-13 after sprint 76 stalled 3× on quota.

**Workaround today (daemon-global):** spawned claude processes inherit the daemon's env (`ws-server.ts` spawnClaude merges `process.env`). So: `mcx serve-kill`, then in a shell run `source <(grep '^export' ~/github/claude_bedrock.sh)` and any `mcx` command — the auto-started daemon carries the Bedrock vars and every subsequent spawn uses Bedrock. Fragile: a later daemon auto-start from a non-Bedrock shell silently reverts.

**Caveat RESOLVED by #2659 (sprint 77, PR #2929, merged 2026-08-03).** `resolveModelName` is gone. `MODEL_SHORTNAMES` (`packages/core/src/model.ts`) is now a `ReadonlySet` used only as a vocabulary for the sprint plan's Model column, and mcx passes tier names through verbatim. The `claude` CLI resolves the tier itself — latest-in-tier on the Anthropic API, and via `ANTHROPIC_DEFAULT_{OPUS,SONNET,FABLE,HAIKU}_MODEL` on Bedrock. So **`--model opus` is now the correct thing to pass under Bedrock**, and pre-resolved `us.anthropic.*` IDs are what to avoid (they defeat the tier-alias envs).

Why the old caveat existed: the map turned `--model opus` into a concrete ID that went stale on every model release. It was silently spawning sprint-77's first 8 sessions a tier behind (`claude-opus-4-8` while Opus 5 was current) before #2659 caught it.
