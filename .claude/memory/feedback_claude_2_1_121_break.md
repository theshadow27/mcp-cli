---
name: Claude 2.1.121 sdk-url break + workaround
description: Anthropic added a 5-host allowlist on `--sdk-url` in claude 2.1.121 that breaks every mcx-spawned session. Pin via `claudeBinary` config; user's local PATH `claude` advances freely.
type: feedback
originSessionId: 8be6c24d-3c8c-419f-9862-e43e3b61a449
---
**Rule:** mcx-spawned claude sessions must use a known-working pre-2.1.121 binary (currently 2.1.119). The user's interactive `~/.local/bin/claude` is a normal symlink that auto-updates — it does NOT serve mcx anymore.

**Why:** Claude Code CLI 2.1.121 (build `16ffea72`, dropped 2026-04-27) added a runtime check that rejects `--sdk-url ws://localhost:...` with: *"host 'localhost' is not an approved Anthropic endpoint."* The check is a string-match against a 5-host allowlist (`api.anthropic.com`, `api-staging.anthropic.com`, `beacon.claude-ai.staging.ant.dev`, `claude.fedstart.com`, `claude-staging.fedstart.com`). This breaks every mcx session spawn, since mcx hosts its own WebSocket transport at `ws://localhost:<port>`. Filed as issue #1808 (the user is solving this in a parallel session — daemon-side wiring of a binary patcher + TLS listener).

**Current pinning mechanism (sprint 51 plan, 2026-05-03):**

mcx now resolves the spawn binary in this precedence order (see `packages/daemon/src/claude-session/binary-resolver.ts` and `packages/core/src/config.ts:101`):

1. `MCX_CLAUDE_BINARY` env var (per-process override)
2. `claudeBinary` config field in `~/.mcp-cli/config.json` ← **this is what's pinned now**
3. `which claude` on PATH (fallback)

The pinned config value is:
```
claudeBinary = ~/.local/share/mcp-cli-archive/claude-code/claude-2.1.119
```

The user's `~/.local/bin/claude` is now a normal symlink to `~/.local/share/claude/versions/<latest>` and auto-updates freely (interactive `claude` benefits from upstream bugfixes). The chflags-uchg wrapper-script approach was retired 2026-05-03 — no longer needed.

**Archive integrity:**

Five binaries at `~/.local/share/mcp-cli-archive/claude-code/` (2.1.114, 2.1.116, 2.1.117, 2.1.118, 2.1.119) are protected by `chflags uchg` against accidental `rm`. SHA-256 digests in the archive's `README.txt`:
- `claude-2.1.119` → `31db3444309d5d0f8b85e8782e2dcd86f31f7e48c1a1e83d69b09268c7b4f9a2`

The archive is OUTSIDE `~/.local/share/claude/versions/` (which Anthropic prunes — 2.1.119 was already pruned there as of 2026-05-03; the archive is the only surviving copy on this machine).

**How to apply:**

1. **Detection.** If sessions die in <1s with daemon log `Session <id> disconnected: spawn exited` and `Pruned dead session ... pid X no longer alive`, run:
   ```sh
   mcx config get claude-binary           # should print archive path
   "$(mcx config get claude-binary | awk -F= '{print $2}' | xargs)" --version
   # → 2.1.119 (Claude Code)
   ```
   If `claudeBinary` is unset or stale, restore via `mcx config set claude-binary ~/.local/share/mcp-cli-archive/claude-code/claude-2.1.119` then `mcx shutdown && mcx status`.

2. **If the archive copy is missing** (binary deleted despite uchg lock — extremely unlikely): the archive `README.txt` lists prior versions back to 2.1.114. Use the most recent surviving binary; update `claudeBinary` config; restart daemon.

3. **Don't re-pin `~/.local/bin/claude` to 2.1.119.** That was the old workaround. The current setup deliberately keeps the user's interactive `claude` advancing — config-based pinning is the supported path.

4. **Don't file new issues** about this — #1808 has the full reverse-engineering recon. If something new breaks (e.g. 2.1.119 stops working too), comment on #1808 and fall back to 2.1.118 from the archive.
