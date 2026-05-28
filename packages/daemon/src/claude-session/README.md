# Claude Session Transport

The daemon communicates with spawned Claude CLI processes using one of two transports:

## Transports

### `sdk-url` (WebSocket) — legacy

The daemon runs a Bun.serve() WebSocket server. Claude is spawned with
`--sdk-url ws[s]://host:port/session/:id` and connects back via WebSocket.
Messages are NDJSON frames sent as WebSocket text messages. The initial user
prompt is sent in `handleOpen` when the WS connection is established.

This transport requires the patcher (#1808) for claude ≥2.1.120 because
Anthropic locked the `--sdk-url` host allowlist. TLS + IPv6 workaround via
self-signed cert.

### `stdio` (pipes) — new

Claude is spawned with `--print --input-format stream-json --output-format stream-json`
and no `--sdk-url`. Communication uses stdin/stdout pipes with one NDJSON
object per line. The initial user prompt is written to stdin immediately
after spawn. The stdout reader (`startStdioReader`) drains lines and feeds
them through the same `SessionState.handleMessage()` dispatch as the WS path.

No patcher, no TLS, no WebSocket connection overhead. Works with unpatched
claude binaries.

## Version gate

| Claude version | Default transport |
|---|---|
| ≤ 2.1.122 | `sdk-url` (WS + patcher) |
| > 2.1.122 | `stdio` |

The gate is implemented in `transport-resolver.ts` as a pure function
`resolveTransport(configPref, version)`.

## Configuration

`~/.mcp-cli/config.json`:

```json
{
  "transport": "auto"
}
```

Values:
- `"auto"` (default) — version-gated as above
- `"stdio"` — force stdio regardless of version
- `"sdk-url"` — force legacy WS + patcher path

Per-session override via `SessionConfig.transport` (`"ws" | "stdio"`).

Rollback is config-only; takes effect on next spawn.

## `system/init` dedupe

In stdio mode, claude re-emits `system/init` every turn (not just on
connection). `SessionState.applyInit()` tracks `initEmitted` and suppresses
the `session:init` event after the first emission. Model and cwd are still
updated on every init. The flag resets on `reconnect()` and `resetForClear()`.

## Deferred (not in this transport)

- Dynamic permission gating via `PreToolUse` hook → `mcx hook` → mcpd IPC
- Deleting the patcher/TLS/WS stack (retained for ≤2.1.122 support)
- Multi-process stdio load test
