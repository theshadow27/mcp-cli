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
`resolveTransport(configPref, version)`, called once at claude-session-worker
startup and handed to `ClaudeWsServer` as `defaultTransport`. `prepareSession`
uses it for every spawn that carries no per-session override.

**Exception — contained (worktree) sessions stay on `sdk-url`.** ContainmentGuard
rides the `can_use_tool` round-trip, which only the WS transport carries, and
`spawnClaude` fails closed on stdio + worktree (#2688/#2791). Those sessions keep
`ws` regardless of version. Remove the carve-out in `prepareSession` once #2805
gives stdio `can_use_tool` parity.

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

Rollback via `config.json` takes effect on the next **daemon/worker restart**,
not the next spawn: `readCliConfig().transport` is read once in `startServer()`
(`claude-session-worker.ts`) and handed to the long-lived `ClaudeWsServer` as
`defaultTransport`. The per-spawn `mcx claude spawn --transport <ws|stdio>`
override does take effect immediately.

## Behavioural divergences from the WS path

The two transports are not wire-identical. Anything that reads CLI-reported
counters must be checked against both:

- **`num_turns` is not cumulative over stdio.** On `sdk-url` it accumulates
  across the conversation; over `--print` the CLI restarts it at `1` for every
  turn. The #2837 result-idempotency guard keys on `num_turns`, so
  `SessionState.promptDelivered()` resets its baseline **on stdio only** — a new
  stdio work cycle reports `num_turns=1` again and its result can never be a
  replay. Without that reset the guard suppressed `session:result` on every
  follow-up and `mcx claude send --wait` hung forever (#3003).

  The reset is deliberately *not* applied on `ws`, where `num_turns` stays
  cumulative and the baseline is the guard's only defence: dropping it re-opened
  #2837 case B, where a `disconnect()` + `reconnect()` replay arriving while a
  prompt is pending re-emitted the previous turn's result and resolved a
  `send --wait` waiter with a stale answer. `SessionState` therefore takes the
  resolved transport as a constructor argument, and `queuePrompt()` no longer
  touches the baseline at all — `sendPrompt()` calls `promptDelivered()` only
  *after* the transport write succeeds, so a failed write leaves the baseline
  intact (no new turn started).
- **`system/init` is re-emitted every turn** — see below.

## `system/init` dedupe

In stdio mode, claude re-emits `system/init` every turn (not just on
connection). `SessionState.applyInit()` tracks `initEmitted` and suppresses
the `session:init` event after the first emission. Model and cwd are still
updated on every init. The flag resets on `reconnect()` and `resetForClear()`.

## Deferred (not in this transport)

- Dynamic permission gating via `PreToolUse` hook → `mcx hook` → mcpd IPC
- Deleting the patcher/TLS/WS stack (retained for ≤2.1.122 support)
- Multi-process stdio load test
