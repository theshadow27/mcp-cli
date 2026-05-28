---
name: codex-broken-2482
description: "codex spawn is fully broken (RPC -32600) as of sprint 66 — don't route work to codex until"
metadata: 
  node_type: memory
  type: reference
  originSessionId: a70cb538-7ecc-4124-af37-fb5c697c46ed
---

As of sprint 66 (2026-05-27), **`mcx agent codex spawn` fails immediately for any prompt** with `RPC error -32600: Invalid request` — no codex session can be created. The `_codex` virtual server shows connected (9 tools) in `mcx status`, so it's the session-start RPC that's rejected, not the server. Reproduced with both a long `--cwd` prompt and a bare minimal one.

This is a **regression** of the same protocol-drift class as the now-closed #845/#851 (`missing field threadId`) and #666 (`invalid type: map`). Tracked in **#2482**.

**How to apply:** Don't route sprint/repair/refactor work to codex until #2482 is resolved — fall back to opus. In sprint 66 the #2074 holistic refactor was sent to codex first, errored twice, and had to be redone on opus. See [[feedback_codex_retro]] for the broader codex pitfalls (stale binaries, partial branches, schema drift).
