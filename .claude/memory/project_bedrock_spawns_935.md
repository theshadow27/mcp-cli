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

**Caveat:** `resolveModelName` (`packages/core/src/model.ts`) turns `--model opus` into `claude-opus-4-8` — not a Bedrock inference profile. Under Bedrock, either omit `--model` (env `ANTHROPIC_MODEL` applies) or pass full `us.anthropic.*` IDs; explicit resolved IDs also defeat `ANTHROPIC_DEFAULT_*_MODEL` tier aliases.
