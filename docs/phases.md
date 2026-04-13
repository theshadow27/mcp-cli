# Declarative phases with `.mcx.yaml`

mcx projects can define a phase graph in a manifest at the repo root
(`.mcx.yaml`, `.mcx.yml`, or `.mcx.json`). Each phase is a small TypeScript
script that decides what happens when a tracked work item enters that phase:
spawn a session, wait for external state, or transition to a neighbour.

This guide covers the manifest schema, the phase handler API, and how to
copy-adapt mcp-cli's sprint pipeline for your own project.

## Minimal example

```yaml
# .mcx.yaml
version: 1
runsOn: main          # orchestrator must `cd` to a checkout of this branch
initial: build

state:
  build_ok: boolean?  # per-work-item scratchpad declarations

phases:
  build:
    source: ./.claude/phases/build.ts
    next: [test]
  test:
    source: ./.claude/phases/test.ts
    next: [done]
  done:
    source: ./.claude/phases/done.ts
    next: []
```

```typescript
// .claude/phases/build.ts
import { defineAlias, z } from "mcp-cli";

export default defineAlias({
  name: "phase-build",
  description: "Compile the work item's branch.",
  input: z.object({}).default({}),
  output: z.object({ ok: z.boolean() }),
  fn: async (_input, ctx) => {
    const proc = Bun.spawnSync({ cmd: ["bun", "run", "build"] });
    const ok = proc.exitCode === 0;
    await ctx.state.set("build_ok", ok);
    return { ok };
  },
});
```

## Manifest schema

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `version` | `1` | yes | Manifest format discriminator |
| `runsOn` | string | no | Branch the orchestrator must stand on (e.g. `main`) |
| `worktree.setup` | string | no | Command run after worktree creation |
| `worktree.teardown` | string | no | Command run before worktree removal |
| `worktree.base` | string | no | Base branch for new worktrees |
| `state` | map | no | Per-work-item scratchpad key types (advisory) |
| `initial` | phase name | yes | Starting phase for a newly tracked item |
| `phases` | map | yes | Phase-name → `{ source, next }` |

Phase names and state keys must match `^[a-z][a-z0-9_-]{0,63}$`. The phase
graph may contain cycles (review → repair → review is legal); only
unreachable-from-initial phases are rejected.

State types are `string`, `number`, `boolean`, each optionally suffixed
with `?` (e.g. `string?`). Runtime enforcement is wired in #1286.

## Phase source URIs

Supported schemes today:

- `./relative/path.ts` — resolved against the manifest directory
- `/absolute/path.ts` — used as-is
- `file:///absolute/path.ts` — URI form of absolute

Planned (parsed today, install deferred):

- `github:owner/repo/path@version#sha256=<64hex>`
- `https://example.com/phase.ts#sha256=<64hex>`

Remote sources always carry an inline `sha256` pin — no unpinned network
fetches.

## Phase handler API

Phase scripts use `defineAlias({ name, description?, input?, output?, fn })`
exactly like normal aliases. The handler receives a scoped `ctx`:

| Field | Purpose |
|-------|---------|
| `ctx.mcp` | Proxy for MCP tool calls, e.g. `ctx.mcp._work_items.work_items_update({...})` |
| `ctx.state` | Per-work-item scratchpad (`get`, `set`, `delete`, `all`) |
| `ctx.globalState` | Shared scratchpad across all phases in the repo |
| `ctx.workItem` | `{ id, issueNumber, prNumber, branch, phase }` or null |
| `ctx.args` | CLI `--key value` pairs |
| `ctx.file`, `ctx.json` | Read utility helpers |
| `ctx.cache` | TTL-bounded cached producer |

Bun globals (`Bun.spawnSync`, `fetch`) are available — phases typically shell
out to `gh`, `git`, or project tooling.

## What a handler should return

Phase handlers return whatever their `output` Zod schema declares. Mcp-cli's
sprint pipeline uses a discriminated union with three actions:

```typescript
{ action: "spawn", command: [...], prompt: "...", model: "opus", ... }
{ action: "wait",  reason: "sticky review comment not posted yet" }
{ action: "goto",  target: "repair", reason: "blockers remain" }
```

The orchestrator reads this and either runs the spawn command, backs off, or
invokes `mcx phase run <target>`. Nothing forces this exact shape — design
your output schema to fit how your orchestrator (human or agent) consumes it.

## CLI

```bash
mcx phase install                  # resolve sources + write .mcx.lock
mcx phase check                    # detect drift between lock and sources
mcx phase list [--json]            # summarise all phases
mcx phase show <name> [--full]     # resolved source, hash, schema, preview
mcx phase why <from> <to>          # is this transition allowed?
mcx phase run <target> \           # validate + log a transition
     --from <current> --work-item <id>
mcx phase run <name> --dry-run     # execute the handler with a logging proxy
```

Transitions are logged to `.mcx/transitions.jsonl`. Disallowed or regressive
transitions fail unless `--force "<message>"` is supplied.

## Copying mcp-cli's sprint pipeline

The seven files under `.claude/phases/` and the `.mcx.yaml` at the repo root
are self-contained. To adapt them for another project:

1. Copy `.mcx.yaml` and `.claude/phases/` into the new repo
2. Edit the spawn commands in `impl.ts` / `review.ts` / `qa.ts` / `repair.ts`
   to match your slash commands (replace `/implement`, `/adversarial-review`,
   `/qa`) and the provider list you support
3. Adjust the triage script path in `triage.ts` if your project doesn't have
   `.claude/skills/estimate/triage.ts` — or vendor that script too
4. Run `mcx phase install` to generate `.mcx.lock`
5. `mcx phase list` to verify all phases resolve cleanly

The round caps (review ≤ 2, repair ≤ 3, qa:fail ≤ 2) live in each script's
constant — bump them if your project's quality bar tolerates more loops.
