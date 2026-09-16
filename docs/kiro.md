# Kiro (`mcx agent kiro`)

Kiro CLI is a first-class ACP agent provider, alongside grok/copilot/gemini. It
speaks native ACP through the `kiro-cli acp` subcommand, so it reuses the shared
`_acp` server, permission engine, and containment guard.

```bash
mcx agent kiro spawn -t "review this diff" --allow Read Grep Bash
```

Kiro launches as `kiro-cli acp --agent-engine v3`.

## Authentication (reads kiro-cli's login)

Unlike copilot/gemini/grok — which authenticate out-of-band from their own token
stores — Kiro's agent server (KAS) runs with `--auth=acp-callback`: it asks the
ACP **client** (mcx) to supply an access token via a `_kiro/auth/getAccessToken`
JSON-RPC callback. mcx answers that callback, sourcing the token in three tiers:

1. **`KIRO_API_KEY`** in the environment, if set. Mirrors KAS's own
   `selectAuthProvider`, where a present key skips the callback entirely.
2. **kiro-cli's own login token**, otherwise — read from the local credential
   store the same way mcx reads Claude Code's tokens:
   - **macOS:** the login Keychain, service `kirocli:odic:token`
     (`/usr/bin/security find-generic-password`).
   - **Linux / fallback:** the `auth_kv` table of `data.sqlite3` under
     `$XDG_DATA_HOME/kiro-cli` (or `~/.local/share/kiro-cli`); on macOS the same
     file mirrors the Keychain. Opened **read-only** so kiro-cli's live store is
     never locked or mutated.
   - The CodeWhisperer **profile ARN** is read from the `state` table
     (`api.codewhisperer.profile`); KAS derives the service region from it, so
     omitting it causes `ModelRegistryUnavailableError`.
   - The token is used only while valid (a 3-minute pre-expiry buffer matches
     KAS's own refresh window); refreshing is kiro-cli's job. Run
     `kiro-cli login` (or any authed `kiro-cli` command) to refresh.
3. If neither yields a usable token, mcx answers empty and KAS raises its own
   auth error, which mcx rewrites into an actionable "run `kiro-cli login`" hint.

**Security:** the `_kiro/auth/getAccessToken` handler is gated to `kiro` sessions
only. A different ACP agent (grok/copilot/gemini, or an arbitrary
`--agent <name>` / `customCommand` binary) that emits the method receives
nothing — it cannot harvest the Kiro credential.

### Environment variables

| Variable | Purpose |
|---|---|
| `KIRO_API_KEY` | Explicit Kiro API key; takes precedence over the local login token. |
| `KIRO_PROFILE_ARN` | Profile ARN to send with a `KIRO_API_KEY` token (region resolution). |
| `KIRO_ACCESS_TOKEN_TTL_MS` | Expiry (ms from now) reported for a `KIRO_API_KEY` token. Default 1h. |
| `MCX_KIRO_DATA_DIR` | Override kiro-cli's data dir (where `data.sqlite3` lives). Tests / non-standard installs. |
| `MCX_KIRO_DISABLE_TOKEN_LOOKUP` | `1` disables the Keychain/SQLite lookup entirely (force `KIRO_API_KEY`-only). |

## Permissions

Kiro's `session/request_permission` carries the tool call under `toolCall` and
`_meta.kiro` (`toolId`, `consent.capability`, `command`) rather than the flat
`tool`/`command`/`path` fields copilot/gemini use. mcx maps kiro's coarse
capability to the Claude-style tool names the permission engine speaks
(`shell` → `Bash`, `fsRead` → `Read`, `fsWrite` → `Write`), so `--allow Bash`,
`--allow Read`, etc. (unioned with `DEFAULT_SAFE_TOOLS`) match kiro's
`run_command` / file tools. See [`docs/trust.md`](trust.md) for the rule syntax.

Kiro delegates command execution back to the client via `terminal/create`
(mcx runs it, capturing output) and reports its shell type via
`_kiro/terminal/shell_type`. Because kiro sends a whole command line as a single
string, mcx runs it through `sh -c` when no separate argv is supplied.

## Test coverage

Real-binary runs need an authenticated `kiro-cli login` that CI lacks, so the
agent grid marks kiro `untested` (`agent-grid/versions.yaml`). The mcx-side auth,
permission-mapping, and protocol behavior are covered by unit/integration specs:
`packages/core/src/kiro-token.spec.ts` and
`packages/acp/src/acp-session-kiro.spec.ts`.
