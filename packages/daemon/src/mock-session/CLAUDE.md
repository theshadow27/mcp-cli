# Mock Script DSL

The mock provider reads a JSON script file and replays canned events with configurable delays.
It covers the full `AgentSessionEvent` protocol surface so tests can exercise any provider behavior
without needing a real agent binary.

## Script format

A script is a JSON array of entries. Each entry is one of:

### Emit entries (discriminated on `emit`)

All emit entries accept an optional `delay` (ms) applied before the emit.

| `emit` | Required fields | Optional fields | Event emitted |
|---|---|---|---|
| `init` | | `session_id`, `delay` | `session:init` |
| `response` | `text` | `delay` | `session:response` |
| `tool_call` | `name` | `args`, `delay` | `session:response` (formatted as `[tool_call] name(args)`) |
| `permission_request` | `tool` | `args`, `request_id`, `delay` | `session:permission_request` |
| `cost` | | `usd`, `tokens_in`, `tokens_out`, `delay` | `db:cost` (accumulates into final result) |
| `result` | | `text`, `delay` | `session:result` (terminal) |
| `error` | | `message`, `messages`, `delay` | `session:error` (terminal) |
| `disconnect` | | `reason`, `delay` | `session:disconnected` (terminal) |
| `end` | | `delay` | `session:ended` (terminal) |

### Wait entries (discriminated on `wait_for`)

| Field | Type | Description |
|---|---|---|
| `wait_for` | `"approve" \| "deny"` | Blocks until the parent calls `mock_approve` or `mock_deny` |
| `timeout_ms` | `number` | Max wait time (default: 5000ms) |

Place a `wait_for` entry immediately after a `permission_request` to model the approval round-trip.

### Legacy entries

The original `{delay, text}` format still works and emits `session:response`.

## Behavior

- If the script does not start with `{"emit": "init"}`, the worker auto-emits `session:init` before processing.
- If no terminal entry (`result`, `error`, `disconnect`, `end`) appears, the worker auto-emits `session:result` after the last entry.
- Cost and token values from `cost` entries accumulate and appear in the final `session:result`.
- `permission_request` entries register a pending permission waiter. Use `mock_approve` / `mock_deny` tools to resolve them. The `request_id` field lets you target a specific request.

## Examples

### Simple response script
```json
[
  {"emit": "response", "text": "Hello, world!"},
  {"emit": "result", "text": "done"}
]
```

### Permission round-trip
```json
[
  {"emit": "permission_request", "tool": "Write", "args": {"path": "/tmp/x"}, "request_id": "req-1"},
  {"wait_for": "approve", "timeout_ms": 5000},
  {"emit": "response", "text": "Write approved, continuing"},
  {"emit": "result", "text": "done"}
]
```

### Error scenario
```json
[
  {"emit": "response", "text": "working..."},
  {"emit": "error", "message": "out of tokens"}
]
```

### Cost tracking
```json
[
  {"emit": "cost", "usd": 0.001, "tokens_in": 100, "tokens_out": 50},
  {"emit": "response", "text": "processed"},
  {"emit": "cost", "usd": 0.002, "tokens_in": 200, "tokens_out": 100},
  {"emit": "result", "text": "done"}
]
```

### Legacy format (still supported)
```json
[
  {"delay": 100, "text": "Hello"},
  {"delay": 0, "text": "Done"}
]
```
