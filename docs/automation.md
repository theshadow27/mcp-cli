# Automation Modules

Automation modules are small, event-triggered handlers declared in `.mcx.yaml`
that perform mechanical pipeline steps without orchestrator involvement.
Framework introduced in #2018; individual modules ship as separate issues.

## Schema

Add an `automation:` section to `.mcx.yaml`:

```yaml
automation:
  preset: supervised   # supervised | semi-auto | autonomous

  modules:
    cleanup:
      source: ./.claude/automation/cleanup.ts
      on: [pr.merged]
      enabled: true

    bind:
      source: ./.claude/automation/bind.ts
      on: [pr.opened]
      # enabled omitted — resolved from preset

    merge:
      source: ./.claude/automation/merge.ts
      on: [pr.merge_state_changed, ci.finished]
      enabled: false
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `preset` | `supervised \| semi-auto \| autonomous` | No (default: `supervised`) | Preset that sets default enabled state for well-known modules |
| `modules.<name>.source` | `string` | Yes | Path to the handler script (relative to repo root) |
| `modules.<name>.on` | `string[]` | Yes | Events to subscribe to (at least one) |
| `modules.<name>.enabled` | `boolean` | No | Explicit enable/disable; overrides preset default |

Module names must match `^[a-z][a-z0-9_-]{0,63}$`.

### Valid events

`pr.opened`, `pr.pushed`, `pr.merged`, `pr.closed`, `pr.merge_state_changed`,
`pr.review_comment_posted`, `checks.started`, `checks.passed`, `checks.failed`,
`ci.started`, `ci.running`, `ci.finished`, `review.approved`,
`review.changes_requested`, `review.commented`, `phase.changed`,
`session.ended`, `session.result`

## Handler API

Automation handlers use `defineAutomation` (imported from the `mcp-cli` virtual
module, same pattern as `defineAlias`):

```typescript
import { defineAutomation } from "mcp-cli";

export default defineAutomation({
  name: "my-module",
  events: ["pr.merged"],
  fn: async (event, ctx) => {
    // ctx provides: workItem, state, mcp, repoRoot, logger, emit, signal
    return { action: "none", reason: "nothing to do" };
  },
});
```

### Context

| Property | Type | Description |
|----------|------|-------------|
| `ctx.workItem` | `WorkItem \| null` | The work item associated with the event |
| `ctx.state` | `AliasStateAccessor` | Per-module persistent state |
| `ctx.mcp` | `McpProxy` | Proxy for calling MCP server tools |
| `ctx.repoRoot` | `string` | Repository root path |
| `ctx.signal` | `AbortSignal` | Abort signal (30s timeout) |
| `ctx.logger` | `{ info, warn, error }` | Structured logger |
| `ctx.emit` | `(event) => void` | Emit a new event onto the bus |

### Return actions

Every handler returns a structured action:

| Action | Shape | Effect |
|--------|-------|--------|
| `none` | `{ action: "none", reason: string }` | No-op, logged for audit |
| `bye-and-untrack` | `{ action: "bye-and-untrack", sessionIds: string[] }` | Daemon byes sessions + untracks item |
| `set-state` | `{ action: "set-state", patch: Record<string, unknown> }` | Daemon writes work_item fields/state |
| `emit-event` | `{ action: "emit-event", event: {...} }` | Daemon emits a new event onto the bus |
| `shell` | `{ action: "shell", cmd: string, args: string[] }` | Daemon executes a shell command |
| `escalate` | `{ action: "escalate", reason: string, payload? }` | Emits `automation.escalated` event for orchestrator |

> **Note:** Action execution is deferred to individual module PRs (#2020, #2021).
> The framework records actions in the audit log but does not yet execute
> side effects (`bye-and-untrack`, `set-state`, `shell`, etc.). The `escalate`
> action emits its audit event immediately. The `shell` action type will
> require an allowlist/security model before the executor ships.

## Slider presets

Presets set default `enabled` state for well-known module names. Explicit
`enabled:` in the manifest always overrides the preset.

| Preset | cleanup | bind | merge | Other modules |
|--------|---------|------|-------|---------------|
| `supervised` (default) | off | off | off | All opt-in only |
| `semi-auto` | on | on | off | Cleanup + bind auto; merge manual |
| `autonomous` | on | on | on | Everything on; orchestrator only on escalation |

When `enabled` is omitted from a module definition, the preset fills in the
default at `mcx phase install` time and writes the resolved value to `.mcx.lock`.

## Escalation contract

When a module cannot handle an event mechanically, it returns:

```typescript
return { action: "escalate", reason: "merge conflict detected", payload: { ... } };
```

This emits an `automation.escalated` event on the bus. The orchestrator
subscribes to this event and handles it like any other monitor event — no
special protocol, just another event in the stream.

## Per-work-item overrides

Modules check per-item overrides on every fire (not cached). Set overrides
via `mcx track`:

```bash
mcx track 1234 --automation merge=false
mcx track 1234 --automation merge=true,bind=false
```

Stored as CSV in `workItem.automationOverrides`. Parsed at dispatch time.
Per-item overrides take precedence over module config and preset defaults.

## Lifecycle

1. **Install:** `mcx phase install` resolves `automation.modules[*].source`,
   content-hashes them, and writes to `.mcx.lock`.
2. **Daemon startup:** Daemon reads `.mcx.lock`, creates `AutomationDispatcher`,
   registers event subscriptions on the EventBus.
3. **Event fires:** On matching event, dispatcher invokes module handler
   (30s timeout).
4. **Audit:** Every dispatch records outcome in ring buffer and emits
   `automation.{fired|skipped|errored|escalated}` event.
5. **Introspection:** `mcx automation list/show/log` queries dispatcher state
   via IPC.

## CLI commands

```bash
mcx automation list              # show all modules, events, enabled state
mcx automation show <name>       # details for a specific module
mcx automation log [name]        # recent audit entries
mcx automation log --limit 20   # limit entries
```

## Copy-adapt guide

To add automation to your project:

1. Add `automation:` to `.mcx.yaml` (see Schema above)
2. Create handler script(s) using `defineAutomation`
3. Run `mcx phase install` to resolve and lock
4. Start daemon — modules activate automatically
5. Use `mcx automation list` to verify
6. Set per-item overrides with `mcx track <n> --automation <csv>`

See also: [phases.md](phases.md) for the manifest and lockfile system that
automation builds on.
