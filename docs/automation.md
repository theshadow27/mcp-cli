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

> **Note:** The `bye-and-untrack` action is fully executed (#2020). Other
> action types (`set-state`, `shell`) are recorded in the audit log but do
> not yet execute side effects. The `escalate` action emits its audit event
> immediately. The `shell` action type will require an allowlist/security
> model before the executor ships.

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

## Worked example: cleanup module (#2020)

The `cleanup` module fires on `pr.merged`, verifies the merge via `mergeSha`,
collects all `*_session_id` keys from the work item state, and returns
`bye-and-untrack`. The daemon then ends each session, sets phase to `done`,
and untracks the work item.

```typescript
import { defineAutomation } from "mcp-cli";

const SESSION_KEY_PATTERN = /session_id$/;

export default defineAutomation({
  name: "cleanup",
  events: ["pr.merged"],
  fn: async (event, ctx) => {
    if (typeof event.mergeSha !== "string" || !event.mergeSha) {
      return { action: "none", reason: "missing mergeSha" };
    }

    const state = await ctx.state.all();
    const sessionIds: string[] = [];
    for (const [key, value] of Object.entries(state)) {
      if (SESSION_KEY_PATTERN.test(key) && typeof value === "string" && value.length > 0) {
        if (!value.startsWith("pending:")) sessionIds.push(value);
      }
    }

    if (sessionIds.length === 0) {
      return { action: "none", reason: "no session IDs in state" };
    }

    return { action: "bye-and-untrack", sessionIds };
  },
});
```

**Verification logic:** The module checks `mergeSha` is present and non-empty.
The `pr.merged` event is only emitted by the work-item poller after the GitHub
API confirms `state === "MERGED"`. Auto-merge queued ≠ proof of merge — the
poller is the verification gate, and `mergeSha` is the proof.

**Per-work-item override:** To prevent cleanup on a specific item:

```bash
mcx track 1234 --automation cleanup=false
```

**Preset defaults:** Cleanup is enabled in `semi-auto` and `autonomous` presets.

See also: [phases.md](phases.md) for the manifest and lockfile system that
automation builds on.

## Worked example: bind module

The **bind** module auto-attaches a PR number and branch to a tracked work
item when a `pr.opened` event fires. It is the second reference module
(after cleanup) and ships as #2021.

### How it works

1. A `pr.opened` event arrives with `prNumber` and `branch`.
2. The module looks up work items by branch (direct match).
3. If no direct match and `branchPattern` is configured, it extracts an
   issue number from the branch name via a named capture group `(?<issue>\d+)`
   and looks up by issue number.
4. If a matching unbound item is found, it returns `set-state` with
   `{ prNumber, branch }`.
5. If the item already has a `prNumber`, the module no-ops (idempotent).

### Manifest

```yaml
automation:
  preset: semi-auto   # bind on by default

  modules:
    bind:
      source: ./.claude/automation/bind.ts
      on: [pr.opened]
      # Optional: extract issue number from branch naming convention
      config:
        branchPattern: '^(?:feat|fix)/issue-(?<issue>\d+)-'
```

### Per-item override

```bash
mcx track 1234 --automation bind=false   # skip auto-bind for this item
```

### Context methods used

The bind module uses two context methods introduced alongside the module:

- `ctx.findWorkItemByBranch(branch)` — look up a work item by its branch field
- `ctx.findWorkItemByIssue(issueNumber)` — look up a work item by issue number
- `ctx.config` — module-specific config from the manifest (e.g., `branchPattern`)

### Module config

Modules can declare a `config:` bag in the manifest. The config is
passed through the lockfile and available as `ctx.config` at runtime.
Config is a flat `Record<string, unknown>` — keep it simple.
