---
name: Claude 2.1.121 sdk-url break + workaround
description: Anthropic added a 5-host allowlist on `--sdk-url` in claude 2.1.121 that breaks every mcx-spawned session. Workaround in place; do not blindly re-symlink.
type: feedback
originSessionId: 8be6c24d-3c8c-419f-9862-e43e3b61a449
---
**Rule:** If `mcx claude spawn` is producing sessions that immediately disconnect with `spawn exited`, do NOT just re-pin the symlink — verify the wrapper script + `chflags uchg` lock at `~/.local/bin/claude` is still intact first.

**Why:** Claude Code CLI 2.1.121 (build `16ffea72`, dropped 2026-04-27) added a runtime check that rejects `--sdk-url ws://localhost:...` with: *"host 'localhost' is not an approved Anthropic endpoint."* The check is a string-match against a 5-host allowlist (`api.anthropic.com`, `api-staging.anthropic.com`, `beacon.claude-ai.staging.ant.dev`, `claude.fedstart.com`, `claude-staging.fedstart.com`). This breaks every mcx session spawn, since mcx hosts its own WebSocket transport at `ws://localhost:<port>`. Filed as issue #1808 (the user is solving this in a parallel session — daemon-side wiring of a binary patcher + TLS listener).

**How to apply:**

1. **Detection.** If sessions die in <1s with daemon log `Session <id> disconnected: spawn exited` and `Pruned dead session ... pid X no longer alive`, run `claude --version`. If it prints anything ≥ 2.1.120 and the user hasn't merged the #1808 wiring yet, the symlink got stomped.

2. **Workaround.** The recovery is a wrapper script (NOT a symlink — Anthropic's auto-updater rewrites symlinks within minutes):
   ```sh
   unlink ~/.local/bin/claude
   cat > ~/.local/bin/claude <<'EOF'
   #!/bin/sh
   exec "$HOME/.local/share/mcp-cli-archive/claude-code/claude-2.1.119" "$@"
   EOF
   chmod +x ~/.local/bin/claude
   chflags uchg ~/.local/bin/claude
   ```
   The `chflags uchg` (user-immutable flag) is what stops the auto-updater from overwriting it. Two prior re-pin attempts during sprint 46 were stomped within minutes; the third attempt with `uchg` survived.

3. **Archive location.** Last-known-working binaries (2.1.114 through 2.1.119) are at `~/.local/share/mcp-cli-archive/claude-code/` with sha256s in the README. This directory is OUTSIDE `~/.local/share/claude/versions/` (which Anthropic prunes) and OUTSIDE the project's git tree.

4. **Don't just unlock and re-symlink to the latest.** Even if the auto-updater installs 2.1.122+ and the host check is gone, mcx still won't work until the daemon-side wiring (#1808 components 4/6/7) lands. Until then, 2.1.119 is the only known-working version for autosprint use.

5. **Do not file new issues** about this — the open #1808 already has the full reverse-engineering recon (allowlist verbatim from binary, no DNS, no integrity check, no env bypass). If something new breaks (e.g. 2.1.119 stops working too), comment on #1808.
