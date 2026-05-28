# Agent Protocol Specification

**Version:** 1 (pre-negotiation — `protocol_version` field lands with version negotiation story)

**Status:** Normative. This document is the single source of truth for every message type that crosses the mcpd daemon ↔ agent worker boundary.

**Last updated:** 2026-05-28

---

## 1. Scope and Prior Art

This protocol sits at the **mcpd ↔ agent-worker** boundary — the same boundary as today's Bun `postMessage` channel, formalized and made transport-agnostic. It is:

- **Not** a re-implementation of ACP (which lives at a different layer: editor/IDE ↔ agent).
- **Not** a new agent wire protocol — Claude SDK NDJSON, Codex App Server, and ACP each remain the per-vendor wire format, consumed by per-vendor adapters on the worker side.
- A **harness coordination protocol**: the minimum surface an orchestrator needs to drive a remote harness — spawn, prompt, interrupt, observe lifecycle events, route permission round-trips, collect cost/tokens.

Today this protocol runs over Bun `postMessage`. The same messages must be tunnelable over stdio, WebSocket, or any other reliable duplex byte stream so the worker can run remote (claude-in-docker, claude.ai, Bedrock). Wire format and message schemas are normative; transport is not.

### Message discrimination

The postMessage channel carries two kinds of messages, distinguished by top-level field:

| Discriminator | Kind | Handling |
|---|---|---|
| `jsonrpc: "2.0"` present | MCP JSON-RPC | Forwarded to MCP `Client`/`Server` transport |
| `type: string` present | Control / DB event | Intercepted by daemon or worker message handler |

The `WorkerClientTransport` (main thread) and `WorkerServerTransport` (worker) handle JSON-RPC; everything else is dispatched by type-guard functions (`createIsControlMessage`, `isBaseWorkerEvent`).

### Source files

| File | Role |
|---|---|
| `packages/daemon/src/worker-control-message.ts` | `ControlMessageBase` interface, `createIsControlMessage()` factory |
| `packages/daemon/src/abstract-worker-server.ts` | `BaseWorkerEvent` union, DB event types, `isBaseWorkerEvent()` |
| `packages/daemon/src/worker-transport.ts` | `WorkerClientTransport`, `WorkerServerTransport` |
| `packages/daemon/src/claude-session-worker.ts` | Claude control messages (`InitMessage` with extra fields) |
| `packages/daemon/src/codex-session-worker.ts` | Codex control messages (minimal `InitMessage`) |
| `packages/daemon/src/acp-session-worker.ts` | ACP control messages (minimal `InitMessage`) |
| `packages/daemon/src/opencode-session-worker.ts` | OpenCode control messages (minimal `InitMessage`) |
| `packages/daemon/src/mock-session-worker.ts` | Mock control messages (minimal `InitMessage`) |
| `packages/daemon/src/claude-server.ts` | Claude-specific `monitor:event` extension |
| `packages/core/src/agent-session.ts` | `AgentSessionEvent` union, session state types |

---

## 2. Control Messages (daemon → worker)

Control messages flow from the daemon (main thread) to the worker. Each has a `type` field from a per-provider allowlist, validated by `createIsControlMessage()`.

### 2.1 `init`

Sent once at worker startup. Worker must reply with `ready` (§3.1) or `error` (§3.2).

**Base fields (all providers):**

```typescript
{
  type: "init";
  daemonId?: string;   // daemon instance identifier
}
```

**Claude-only extensions** (`claude-session-worker.ts:48-56`):

```typescript
{
  type: "init";
  daemonId?: string;
  wsPort?: number;       // port hint for WebSocket server
  quiet?: boolean;       // suppress worker-side console logging (tests)
  traceparent?: string;  // W3C Trace Context — worker span becomes child
}
```

**Provider divergence:**

| Field | claude | codex | acp | opencode | mock |
|---|---|---|---|---|---|
| `daemonId` | optional | optional | optional | optional | optional |
| `wsPort` | optional | — | — | — | — |
| `quiet` | optional | — | — | — | — |
| `traceparent` | optional | — | — | — | — |

**Example:**

```json
{ "type": "init", "daemonId": "mcpd-a1b2c3", "wsPort": 0, "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" }
```

### 2.2 `tools_changed`

Sent when the MCP tool list changes (servers added/removed, tool discovery updated). All providers handle this identically: re-emit `notifications/tools/list_changed` to connected MCP clients.

```typescript
{ type: "tools_changed" }
```

**Supported by:** all providers.

### 2.3 `restore_sessions` (Claude only)

Sent after daemon restart to restore previously-active Claude sessions from the SQLite database.

```typescript
{
  type: "restore_sessions";
  sessions: Array<{
    sessionId: string;
    pid: number | null;
    pidStartTime?: number | null;
    state: string;              // e.g. "idle", "active"
    model: string | null;
    cwd: string | null;
    worktree: string | null;
    totalCost: number;
    totalTokens: number;
  }>;
}
```

**Supported by:** claude only. Other providers are stateless-per-spawn; session restoration is not applicable.

**Example:**

```json
{
  "type": "restore_sessions",
  "sessions": [
    {
      "sessionId": "ses-abc123",
      "pid": 12345,
      "pidStartTime": 1748432600000,
      "state": "idle",
      "model": "claude-sonnet-4-6",
      "cwd": "/home/user/project",
      "worktree": null,
      "totalCost": 0.042,
      "totalTokens": 15000
    }
  ]
}
```

### 2.4 `work_item_event` (Claude only)

Sent when a tracked work item (PR, issue) changes state. Forwarded to the Claude session's WebSocket server for real-time event delivery.

```typescript
{
  type: "work_item_event";
  event: WorkItemEvent;  // from packages/core/src/work-item.ts
}
```

**Supported by:** claude only.

### Summary: control message types per provider

| Message | claude | codex | acp | opencode | mock |
|---|---|---|---|---|---|
| `init` | extended | base | base | base | base |
| `tools_changed` | yes | yes | yes | yes | yes |
| `restore_sessions` | yes | — | — | — | — |
| `work_item_event` | yes | — | — | — | — |

---

## 3. Init Handshake (worker → daemon)

After receiving `init`, the worker must reply with exactly one of `ready` or `error`.

### 3.1 `ready`

Signals the worker is initialized and ready to accept MCP JSON-RPC messages.

```typescript
{
  type: "ready";
  [key: string]: unknown;  // provider-specific extensions allowed
}
```

**Claude extension:** includes `port: number` — the actual WebSocket server port.

**Semantics:** The daemon awaits `ready` before wiring up the MCP `Client` transport. If `ready` is not received within the startup timeout, the daemon treats it as a spawn failure.

**Example (Claude):**

```json
{ "type": "ready", "port": 49152 }
```

**Example (all others):**

```json
{ "type": "ready" }
```

### 3.2 `error`

Signals the worker failed during initialization.

```typescript
{
  type: "error";
  message: string;
}
```

**Semantics:** Causes the daemon to reject the worker startup promise. The worker process is terminated.

**Example:**

```json
{ "type": "error", "message": "Claude binary not found at /usr/local/bin/claude" }
```

---

## 4. DB Event Messages (worker → daemon)

Workers emit DB events to persist session state in the daemon's SQLite database. These are defined as the `BaseWorkerEvent` union in `abstract-worker-server.ts:82-90`.

All providers emit the same set of DB events. The daemon dispatches them uniformly regardless of provider.

### 4.1 `db:upsert`

Create or update a session record. All fields except `sessionId` are optional — only changed fields need to be sent.

```typescript
{
  type: "db:upsert";
  session: {
    sessionId: string;
    name?: string;
    pid?: number;
    pidStartTime?: number | null;
    state?: string;
    model?: string;
    cwd?: string;
    worktree?: string;
    repoRoot?: string;
    claudeSessionId?: string;  // Claude only — upstream session ID
  };
}
```

**Example:**

```json
{
  "type": "db:upsert",
  "session": {
    "sessionId": "ses-abc123",
    "pid": 12345,
    "state": "active",
    "model": "claude-sonnet-4-6",
    "cwd": "/home/user/project"
  }
}
```

### 4.2 `db:state`

Update session state only (lightweight alternative to full upsert).

```typescript
{
  type: "db:state";
  sessionId: string;
  state: string;   // see AgentSessionState for known values
}
```

Known state values (`AgentSessionState`): `"connecting"`, `"init"`, `"active"`, `"waiting_permission"`, `"result"`, `"idle"`, `"disconnected"`, `"ended"`.

**Example:**

```json
{ "type": "db:state", "sessionId": "ses-abc123", "state": "idle" }
```

### 4.3 `db:cost`

Report cost and token usage for a session.

```typescript
{
  type: "db:cost";
  sessionId: string;
  cost: number;    // cumulative USD cost
  tokens: number;  // cumulative token count
}
```

**Example:**

```json
{ "type": "db:cost", "sessionId": "ses-abc123", "cost": 0.042, "tokens": 15000 }
```

### 4.4 `db:disconnected`

Session unexpectedly disconnected.

```typescript
{
  type: "db:disconnected";
  sessionId: string;
  reason: string;
}
```

**Example:**

```json
{ "type": "db:disconnected", "sessionId": "ses-abc123", "reason": "process exited with code 1" }
```

### 4.5 `db:end`

Session terminated normally.

```typescript
{
  type: "db:end";
  sessionId: string;
}
```

**Example:**

```json
{ "type": "db:end", "sessionId": "ses-abc123" }
```

### 4.6 `metrics:inc`

Increment a counter metric.

```typescript
{
  type: "metrics:inc";
  name: string;
  labels?: Record<string, string>;
  value?: number;  // default: 1
}
```

**Example:**

```json
{ "type": "metrics:inc", "name": "codex_sessions_total", "labels": { "provider": "codex" } }
```

### 4.7 `metrics:observe`

Record a histogram observation.

```typescript
{
  type: "metrics:observe";
  name: string;
  labels?: Record<string, string>;
  value: number;   // required (no default)
}
```

**Example:**

```json
{ "type": "metrics:observe", "name": "codex_turn_duration_seconds", "value": 12.34 }
```

### 4.8 `monitor:event` (Claude only)

Forward a monitor event from the Claude session's WebSocket server to the daemon's event bus. Not part of `BaseWorkerEvent`; handled by `claude-server.ts` via an extended type guard.

```typescript
{
  type: "monitor:event";
  input: MonitorEventInput;  // from packages/core/src/monitor-event.ts
}
```

**Supported by:** claude only. The daemon's `ClaudeServer` adds this to its event type set via `WORKER_EVENT_TYPES`.

---

## 5. MCP JSON-RPC (bidirectional)

Standard JSON-RPC 2.0 messages flow bidirectionally through the same postMessage channel, multiplexed alongside control/DB events.

### Transport

| Side | Class | File |
|---|---|---|
| Main thread (daemon) | `WorkerClientTransport` | `worker-transport.ts:17-43` |
| Worker thread | `WorkerServerTransport` | `worker-transport.ts:48-69` |

Both implement the MCP SDK's `Transport` interface. Messages with a `jsonrpc` field are routed to the transport; messages with a `type` field are intercepted by the control/DB event handlers.

### Message format

Standard JSON-RPC 2.0:

```typescript
// Request
{ jsonrpc: "2.0", id: number | string, method: string, params?: object }

// Response
{ jsonrpc: "2.0", id: number | string, result?: unknown, error?: { code: number, message: string, data?: unknown } }

// Notification (no id)
{ jsonrpc: "2.0", method: string, params?: object }
```

### Common methods

The daemon sends requests to workers (tools/list, tools/call, etc.) and workers send responses back. Workers may also send notifications (e.g., `notifications/tools/list_changed`).

### Discrimination rule

A message on the postMessage channel is JSON-RPC if and only if it has a `jsonrpc` field. All other messages are control/DB events. This is enforced by the transport wiring: `WorkerClientTransport.onmessage` receives only messages that pass through the worker's `self.onmessage` handler after control messages have been intercepted.

---

## 6. Session Events

The `AgentSessionEvent` union (`packages/core/src/agent-session.ts:67-74`) defines the lifecycle events that agent adapters emit. These events are **not sent directly over the postMessage channel** — instead, workers translate them into DB events (§4) for persistence, and either buffer them (codex/acp/opencode) or forward them via WebSocket (claude) for consumer access.

### Event types

```typescript
type AgentSessionEvent =
  | { type: "session:init"; sessionId: string; provider: AgentProviderName; model: string; cwd: string }
  | { type: "session:response"; text: string }
  | { type: "session:permission_request"; request: AgentPermissionRequest }
  | { type: "session:result"; result: AgentResult }
  | { type: "session:error"; errors: string[]; cost: number | null }
  | { type: "session:disconnected"; reason: string }
  | { type: "session:ended" };
```

### Supporting types

```typescript
type AgentProviderName = "claude" | "codex" | "opencode" | "acp" | (string & {});

interface AgentPermissionRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  inputSummary: string;
}

interface AgentResult {
  result: string;
  cost: number | null;
  tokens: number;
  numTurns: number;
  diff?: string;
}
```

### Event → DB event mapping

| Session event | DB events emitted | State transition |
|---|---|---|
| `session:init` | `db:upsert` (create session) | → `"init"` |
| `session:response` | (buffered or WS-forwarded) | no state change |
| `session:permission_request` | `db:state` → `"waiting_permission"` | → `"waiting_permission"` |
| `session:result` | `db:cost`, `db:state` → `"idle"` | → `"idle"` |
| `session:error` | `db:cost` (tokens: 0), `db:state` → `"idle"` | → `"idle"` |
| `session:disconnected` | `db:disconnected` | → `"disconnected"` |
| `session:ended` | `db:end` | (session removed) |

### Buffering (codex, acp, opencode, mock)

Non-Claude providers buffer session events in a circular buffer (capacity: 200 events). Each event gets a monotonically increasing sequence number. Consumers query via `afterSeq` cursor to retrieve events since a given sequence.

```typescript
interface BufferedEvent {
  seq: number;
  sessionId: string;
  event: AgentSessionEvent;
}
```

### Forwarding (claude)

Claude sessions forward events in real-time over a WebSocket connection to the Claude Code SDK process. The daemon's `ClaudeWsServer` manages this connection. Events are not buffered — they are delivered as they arrive.

---

## 7. Prior-Art Alignment

### 7.1 Claude SDK NDJSON

Reference: [Claude Code SDK documentation](https://docs.claude.com/en/docs/claude-code/sdk)

The Claude SDK emits NDJSON events over stdout. Each line is a JSON object with a `type` field. The mcpd worker protocol's session events map to Claude SDK events as follows:

| mcpd session event | Claude SDK NDJSON type | Alignment |
|---|---|---|
| `session:init` | `system` (with `session_id`) | **Partial.** SDK has richer init metadata (subtype, model, tools, cwd, permissions). mcpd captures a subset via `db:upsert`. |
| `session:response` | `assistant` (with `message.content`) | **Diverge.** SDK emits structured `content_block` deltas (text, tool_use, thinking). mcpd flattens to a single `text` string per response event. Reason: mcpd consumers (monitor, afterSeq) don't need content-block granularity — they display or log the final text. Provider adapters that need block-level detail handle it internally. |
| `session:permission_request` | `tool` (with `tool_use_id`, `approval_state: "pending"`) | **Diverge.** SDK models permissions as tool-use lifecycle states. mcpd uses a dedicated event type with `AgentPermissionRequest` carrying `requestId`, `toolName`, `input`, `inputSummary`. Reason: mcpd's permission routing is provider-neutral and needs a uniform request shape that works for providers without tool-use metadata (e.g., codex). |
| `session:result` | `result` (with `cost_usd`, `total_tokens`, `num_turns`) | **Aligned.** Same fields, same semantics. mcpd's `AgentResult` adds optional `diff`. |
| `session:error` | `result` (with `is_error: true`) | **Diverge.** SDK uses `result` with an error flag. mcpd has a separate `session:error` event with an `errors[]` array and nullable `cost`. Reason: mcpd needs to distinguish "completed with errors" from "completed successfully" at the type level for DB state transitions. |
| `session:disconnected` | (no direct equivalent) | **Diverge.** SDK process exit is implicit (stream ends). mcpd needs an explicit event because the worker continues running — the disconnection is the agent process dying while the worker survives. |
| `session:ended` | (stream EOF) | **Partial.** SDK session end = stream close. mcpd needs an explicit terminal event because the worker lifecycle outlives any individual session. |

**Control messages** (init, tools_changed, restore_sessions, work_item_event) have no Claude SDK equivalents — they exist at the mcpd harness layer, not the agent interaction layer.

**DB events** (db:upsert, db:state, db:cost, etc.) have no Claude SDK equivalents — they are internal persistence messages that the SDK consumer never sees.

### 7.2 Agent Client Protocol (ACP)

Reference: [agentclientprotocol.com](https://agentclientprotocol.com/)

ACP defines an editor/IDE ↔ agent protocol. mcpd's protocol sits at a different layer (daemon ↔ worker), but several concepts overlap:

| mcpd concept | ACP equivalent | Alignment |
|---|---|---|
| `init` control message | ACP `initialize` request | **Diverge.** ACP's initialize is a JSON-RPC method with capability negotiation (`clientCapabilities`, `serverCapabilities`). mcpd's init is a plain message with no negotiation (the version-negotiation story will add `protocol_version`). Reason: mcpd workers are not general-purpose agents — they are harness adapters with a fixed contract. Capability negotiation happens at the `AgentFeatures` level, not the transport level. |
| `ready` handshake | ACP `initialize` response | **Partial.** Both signal "ready to accept requests." ACP's response carries server capabilities; mcpd's `ready` carries only `type` (+ optional provider-specific fields like `port`). |
| `session:response` | ACP `events/progress` notification | **Diverge.** ACP streams structured progress events (thought, tool_call, text). mcpd flattens to a single text string. Same reason as Claude SDK divergence above. |
| `session:permission_request` | ACP `confirmations/request` notification | **Partial.** Both model a round-trip approval flow. ACP uses `confirmations/respond` for the answer; mcpd uses the MCP tool-call response to the permission tool. Shape differs but intent is the same. |
| `session:result` | ACP `tasks/complete` notification | **Aligned.** Both signal task completion with cost/token metadata. |
| `session:error` | ACP `tasks/failed` notification | **Aligned.** Both signal task failure with error details. |
| `db:cost` / `metrics:*` | (no ACP equivalent) | **Diverge.** ACP does not define cost reporting or metrics aggregation. These are mcpd operational concerns. |
| `tools_changed` | ACP `tools/changed` notification | **Aligned.** Same concept: notify the agent that available tools changed. |
| `restore_sessions` | (no ACP equivalent) | **Diverge.** ACP is stateless per connection. Session restoration is an mcpd-specific feature for long-lived daemon processes. |

### 7.3 Refactor-first decision

No renames or restructuring are required to ship protocol version 1. The current type names and message shapes are stable and internally consistent. The divergences from Claude SDK and ACP are intentional design decisions (documented above), not accidental drift.

If a future version aligns more closely with either protocol (e.g., adopting ACP's capability negotiation), that constitutes a breaking change and requires a major version bump.

---

## 8. Versioning

### Scheme

Semver for the protocol version number (`protocol_version` field, added by the version-negotiation story):

- **Major:** breaking changes (removing fields, renaming message types, changing semantics)
- **Minor:** additive changes (new optional fields, new message types)

### Current version

**v1** — documents today's behavior. The `protocol_version` field does not yet exist in messages; it will be added by the version-negotiation story. Until then, absence of the field implies v1.

### Back-compat rules

Within a major version:

- New message types may be added. Workers that don't recognize a control message type must ignore it (log a warning, do not crash).
- New optional fields may be added to existing messages. Consumers must tolerate unknown fields.
- Required fields may not be removed or made optional.
- Field semantics may not change.

### Changelog

| Version | Date | Changes |
|---|---|---|
| 1 | 2026-05-28 | Initial formal specification of existing protocol. |

---

## Appendix A: Complete Message Type Reference

### Daemon → Worker

| Type | Providers | Section |
|---|---|---|
| `init` | all | §2.1 |
| `tools_changed` | all | §2.2 |
| `restore_sessions` | claude | §2.3 |
| `work_item_event` | claude | §2.4 |

### Worker → Daemon

| Type | Providers | Section |
|---|---|---|
| `ready` | all | §3.1 |
| `error` | all | §3.2 |
| `db:upsert` | all | §4.1 |
| `db:state` | all | §4.2 |
| `db:cost` | all | §4.3 |
| `db:disconnected` | all | §4.4 |
| `db:end` | all | §4.5 |
| `metrics:inc` | all | §4.6 |
| `metrics:observe` | all | §4.7 |
| `monitor:event` | claude | §4.8 |

### Bidirectional

| Type | Section |
|---|---|
| MCP JSON-RPC 2.0 | §5 |

## Appendix B: Message Flow

```
Daemon (main thread)                    Worker (Bun Worker thread)
       |                                        |
       |── init ──────────────────────────────> |
       |                                   [start MCP Server]
       |                                        |
       | <────────────────────────── ready ──── |
       |                                        |
       |── jsonrpc tools/call (prompt) ──────> |
       |                                   [spawn agent process]
       |                                        |
       | <──────────── db:upsert (session) ──── |
       | <──────────── db:upsert (pid) ──────── |
       | <──────────── db:state "active" ────── |
       |                                        |
       |                                   [agent runs...]
       |                                        |
       | <──── metrics:inc (turns) ──────────── |
       | <──── db:cost ─────────────────────── |
       | <──── db:state "idle" ─────────────── |
       |                                        |
       | <──── jsonrpc tools/call response ──── |
       |                                        |
       |── tools_changed ──────────────────── > |
       |                                        |
       | <──── db:end ──────────────────────── |
       |                                        |
```
