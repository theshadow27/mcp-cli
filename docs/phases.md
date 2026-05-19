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
| `version` | `1` | no | Manifest format discriminator; defaults to `1` when omitted |
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

Bare state types are `string`, `number`, `boolean`, each optionally
suffixed with `?` (e.g. `string?`). The object form (see below) also
accepts `enum[val1,val2,...]` with optional `?`. Runtime enforcement is
wired in #1286.

### Trackable metadata fields

State fields can use an object form to declare CLI-settable metadata
(`track: true`). These fields are exposed as `mcx track --<key>` flags
and included in `mcx tracked --json` output under a `state` key.

```yaml
state:
  session_id: string?          # bare type — handler-only, not CLI-settable
  scrutiny:                    # object form — CLI-settable
    type: enum[low,medium,high]
    track: true
    default: medium
  bundled_with:
    type: string
    track: true
    repeatable: true           # multiple --bundled-with flags → comma-joined
```

| Property | Type | Default | Meaning |
|----------|------|---------|---------|
| `type` | string | (required) | `string`, `number`, `boolean`, or `enum[val1,val2,...]`, optionally `?` |
| `track` | boolean | `false` | Expose as `mcx track --<key>` flag |
| `repeatable` | boolean | `false` | Allow multiple flags; values comma-joined |
| `default` | string/number/boolean | none | Applied on track when flag is omitted |
| `required` | boolean | `false` | Fail `mcx track` if flag is missing and no default |

Usage:

```bash
mcx track 1234 --scrutiny high
mcx track 1234 --bundled-with 1235 --bundled-with 1236
mcx track --help                   # lists project-declared metadata fields
mcx tracked --json                 # output includes state.scrutiny, etc.
```

Phase handlers read metadata via `ctx.state.get("scrutiny")` — same
accessor as any other state key. The only difference is that trackable
fields can be set at tracking time from the CLI.

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

## The `mcp-cli` virtual package

The `import { defineAlias, z } from "mcp-cli"` in every phase script refers
to a **virtual package** — it is resolved at runtime by the `mcx` binary and
is not published to npm. There is no package to install:

```bash
bun add mcp-cli       # 404 — no published package
bun add @theshadow27/mcp-cli  # wrong — unrelated; the import still won't resolve
```

`mcx phase install` (and the runtime that evaluates handlers) injects the
module into Bun's module registry before executing the script, so the import
resolves correctly during `mcx phase run` regardless of what is in
`node_modules`.

### Getting type safety and LSP support

Because there is no package on disk, `bun typecheck` and your editor will
report `error TS2307: Cannot find module 'mcp-cli'` unless you give the
TypeScript toolchain a declaration to work with. Two approaches:

**Option A — ambient `.d.ts` (recommended, zero config)**

Drop this file into your phase directory:

```typescript
// .claude/phases/mcp-cli.d.ts
declare module "mcp-cli" {
  import type { ZodObject, ZodType, ZodRawShape } from "zod/v4";

  export const z: typeof import("zod/v4").z;

  export interface AliasStateAccessor {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    all(): Promise<Record<string, unknown>>;
  }

  export interface AliasWorkItemInfo {
    id: string;
    issueNumber: number | null;
    prNumber: number | null;
    branch: string | null;
    phase: string;
  }

  export type McpProxy = Record<string, Record<string, (args?: Record<string, unknown>) => Promise<unknown>>>;

  export interface EventFilterSpec {
    subscribe?: string[];
    type?: string | string[];
    session?: string;
    pr?: number;
    workItem?: string;
    src?: string;
    phase?: string;
  }

  export interface MonitorEvent {
    seq: number;
    ts: string;
    src: string;
    event: string;
    category: string;
    workItemId?: string;
    sessionId?: string;
    prNumber?: number;
    [key: string]: unknown;
  }

  export interface AliasContext {
    mcp: McpProxy;
    args: Record<string, string>;
    file: (path: string) => Promise<string>;
    json: (path: string) => Promise<unknown>;
    cache: <T>(key: string, producer: () => T | Promise<T>, opts?: { prefix?: string; ttl?: number }) => Promise<T>;
    state: AliasStateAccessor;
    globalState: AliasStateAccessor;
    workItem: AliasWorkItemInfo | null;
    repoRoot: string;
    signal: AbortSignal;
    waitForEvent(filter: EventFilterSpec, opts?: { timeoutMs?: number; since?: number }): Promise<MonitorEvent>;
  }

  export interface AliasDefinition<I = unknown, O = unknown> {
    name: string;
    description?: string;
    input?: ZodType<I>;
    output?: ZodType<O>;
    fn: (input: I, ctx: AliasContext) => O | Promise<O>;
  }

  export function defineAlias<I, O>(def: AliasDefinition<I, O>): AliasDefinition<I, O>;
}
```

No `tsconfig.json` changes needed as long as the file sits next to your phase
scripts — TypeScript's module resolver picks it up automatically.

**Option B — `tsconfig.json` path alias**

If you have a checkout of mcp-cli locally (or depend on `@theshadow27/mcp-cli`
as a dev dependency), add a `paths` entry so the compiler resolves the import
to the real source:

```json
// tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "mcp-cli": ["./node_modules/@theshadow27/mcp-cli/packages/core/src"]
    }
  },
  "include": [".claude/phases/**/*.ts"]
}
```

Option A is lighter and self-contained; Option B gives you exact types as the
library evolves (at the cost of a dev dependency and keeping the path current).

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

### Dry-run limitations

`mcx phase run <name> --dry-run` is currently unreliable for sprint-style
phases:

- The global `--dry-run` flag is stripped before `cmdPhase` sees it, so the
  command dispatches to the transition validator instead of the handler
  runner (#1396).
- Once that bug is fixed, the dry-run runner invokes handlers with
  `ctx.workItem = null` and an empty `ctx.state`. Handlers that assert on
  `ctx.workItem` (e.g. the sprint phases in `.claude/phases/`) will throw
  rather than preview.

For now, use `mcx phase show <name>` to inspect the resolved source and
schemas; run handlers under the real orchestrator to exercise their logic.
Plumbing a work-item payload through dry-run is tracked in #1396.

## Copying mcp-cli's sprint pipeline

The seven files under `.claude/phases/` and the `.mcx.yaml` at the repo root
are self-contained. To adapt them for another project:

1. Copy `.mcx.yaml` and `.claude/phases/` into the new repo
2. Edit the spawn commands in `impl.ts` / `review.ts` / `qa.ts` / `repair.ts`
   to match your slash commands (replace `/implement`, `/adversarial-review`,
   `/qa`) and the provider list you support
3. Adjust the triage script path in `triage.ts` if your project doesn't have
   `.claude/skills/estimate/triage.ts` — or vendor that script too
4. Drop a `mcp-cli.d.ts` ambient declaration into `.claude/phases/` (see
   [The `mcp-cli` virtual package](#the-mcp-cli-virtual-package) above) so
   `bun typecheck` and your LSP don't report `TS2307` on the import
5. Run `mcx phase install` to generate `.mcx.lock`
6. `mcx phase list` to verify all phases resolve cleanly

The round caps (review ≤ 2, repair ≤ 3, qa:fail ≤ 2) live in each script's
constant — bump them if your project's quality bar tolerates more loops.
