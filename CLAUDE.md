# CLAUDE.md

MCP CLI — Model Context Preservation - call MCP server tools from the command line with zero context overhead, delegate to other Claude Code instances, and monitor operations. 

## Quick Reference

### Validation: `bun run am-i-done`

`bun run am-i-done` is the **single command** for checking whether work is done — run it
before committing. It runs typecheck, lint, the standalone arch checks (args-bounds,
timeouts, teardown, phase-drift), and the full `doing-it-wrong` rule sweep, then tests and
the coverage ratchet — in the optimal order, silent-first with clear output on failure. It
is the **same command the pre-commit hook and CI both run**, so a local pass means a green
PR; running a subset is how violations slip through. In a Claude/agent context it captures
step output to `build/am-i-done-<ts>.txt` and surfaces only the path on failure (protects
context budget).

```bash
bun run am-i-done              # full check: typecheck → lint → rules → tests → coverage
bun run am-i-done --pre-commit # fast static subset (no tests/coverage) — what the hook runs
```

Run the individual steps **only to diagnose a specific `am-i-done` failure** or iterate on
one concern — not as a substitute for the full check:

```bash
bun install                  # install deps
bun typecheck                # tsc -b validation (don't call tsc directly)
bun lint                     # biome check + format (may reformat files — re-read after)
bun run doing-it-wrong       # architecture rule sweep only (see Rules below)
bun test                     # run tests
bun build                    # compile binaries to dist/

# Development
bun dev:daemon               # run daemon directly
bun dev:mcx -- ls            # run CLI directly
bun dev:mcx -- call atlassian search '{"query":"test"}'
```

`bun <script>` is interchangeable with `bun run <script>` for scripts that don't clash with native bun verbs.

## Architecture

```
packages/
  core/      → Shared types, IPC protocol, config types, env expansion
  daemon/    → mcpd: background daemon managing MCP server connections
  command/   → mcx: fast CLI that talks to daemon via Unix socket
  control/   → mcpctl: TUI for daemon status and auth management
```

**Build output:** `dist/mcpd`, `dist/mcx`, `dist/mcpctl` via `bun build --compile`

**Prod dependencies:** `@modelcontextprotocol/sdk`, `zod` (v4)

**Runtime state:** `~/.mcp-cli/` — SQLite db, aliases, PID file, socket

## Key Patterns

- **IPC**: Unix socket at `~/.mcp-cli/mcpd.sock`, HTTP with JSON request/response bodies (`POST /rpc`)
- **Config**: reads Claude Code's `~/.claude.json` + `.mcp.json` natively
- **Transports**: stdio (command+args), HTTP (StreamableHTTP), SSE
- **Auth**: macOS Keychain reader (Claude Code tokens) → SQLite → env vars
- **Event bus**: unified per-daemon stream (`event-bus.ts`, `event-stream.ts`) fan-outs server / session / work-item / PR / CI / cost / quota events. Consumed by `mcx monitor`, phase scripts via `ctx.waitForEvent`, and automation modules. Payloads come pre-enriched by the producers so consumers don't need a hydration loop.
- **Work items**: `work_items` SQLite table — every tracked issue/PR has a row with phase, branch, PR number, scrutiny, session bindings, round counters. Phase scripts read/write via `_work_items` MCP tools and `ctx.state`. `work_item.phase_changed` is emitted on every transition.
- **Agent sessions**: daemon hosts Claude / Codex / ACP / OpenCode / Copilot / Gemini / Mock sessions as workers. WS protocol for Claude; subprocess wrappers for the others. Unified session-state machine; `mcx claude` and `mcx agent <provider>` share the same surface.
- **Aliases**: TypeScript scripts in `~/.mcp-cli/aliases/`, executed via Bun virtual module `"mcp-cli"`. Metadata in SQLite `aliases` table. Two modes:
  - **defineAlias**: structured definitions with Zod input/output schemas, typed handler function. Virtual module provides `defineAlias`, `z`.
  - **Freeform** (legacy): side-effect scripts; `import { mcp, args, file, json }` auto-prepended if missing.

## Rules

- Bun all the way — no Node.js compat shims
- `bun:sqlite` for persistence — zero external deps
- Never use `any` — strict TypeScript
- Tests: `*.spec.ts`, import from `bun:test`
- Never use `mock.module()` — it pollutes Bun's global module registry across test files. Use dependency injection (optional constructor/function params) instead.
- Keep binaries lean — fast startup matters (<50ms for `mcx call`)
- JSON output to stdout, errors/status to stderr
- **Coverage ratchet**: never lower thresholds or add exclusions in `scripts/check-coverage.ts`. If new code drops coverage, add tests to bring it back up.
- **Flaky test prevention**: see `test/CLAUDE.md` for required patterns. The core philosophy (adopted from Bun's upstream guidelines) is **test the CONDITION, not TIME PASSING** — never use `setTimeout` for waiting, never hardcode ports, always poll with deadlines instead of fixed delays. Per-test `{ timeout: N }` overrides are a code smell; use file-level `setDefaultTimeout()` instead so the time-budget profiler can see the slowness. Rules `poll-until-headroom`, `no-hardcoded-test-port`, and the pollUntil 1500ms default mechanize this.
- **No shell interpolation**: never pass template literals with `${}` to `execSync` or `execFileSync` — use `spawnSync("cmd", [...args])` instead.
- **Architectural rules**: `scripts/rules/*.rule.ts`, swept by `bun run doing-it-wrong` and run as part of `bun run am-i-done` — wired into both the pre-commit hook and CI. Permanent exception: `// dotw-ignore <rule-id>: <reason>`. Temporary: `// dotw-todo <rule-id>: <desc> — fix in #NNN`. Rule sources are the canonical "what the rule means" docs. See `scripts/ROADMAP.md` for migration status.
- **Duplication & abstraction**: choose the seam that fits the maintainer — **abstract the nouns (shared data contracts), duplicate the verbs (behavior); abstract what changes together, duplicate what changes independently.** Independently-evolving copies are fine; the cost to watch is an invariant drifting across mirrors. Rules should mechanize a real invariant rather than de-duplication on its own. See `docs/architecture/duplication.md`.
- **Test time budget**: no single test file should take >5s in isolation. If it does, extract pure logic into unit tests or split the file. `scripts/check-coverage.ts` profiles every test file and warns on overages (does not block commits — see #812 for the replacement plan).
- **No implementation code in index files**: `index.ts` is for barrel exports only. Entry points go in `main.ts` (or `main.tsx`). This keeps testable code separate from untestable process boilerplate.
- **Bun segfaults / coverage crashes**: The historical worker-cleanup segfault was tracked in #1004 (closed 2026-04-11, fixed upstream). Do NOT file new crashes under #1004 — open a fresh issue with the bun.report URL, address, Bun version, reproducible commit, and (if applicable) the bisect anchor. **Always `open` the bun.report URL** so Bun gets the crash telemetry.

## Orchestration manifest

`.mcx.yaml` at the repo root declares the sprint phase graph (impl → triage
→ review/qa → repair/done/needs-attention). Per-phase logic lives in
`.claude/phases/*.ts` as `defineAlias` scripts — inspect with `mcx phase
show <name>`. Do not rely on `mcx phase run <name> --dry-run` to preview
sprint phases: the current dry-run runner does not provide work-item
context, so phases that require `ctx.workItem` will throw. Run `mcx phase
install` after editing any phase source to regenerate `.mcx.lock`. See
`docs/phases.md` for the manifest schema and authoring guide.

## Project Structure

```
packages/core/src/
  index.ts          Barrel export (no impl code — see rule below)
  ipc.ts            IPC protocol types (IpcRequest, IpcResponse, IpcMethod)
  ipc-client.ts     IPC client, daemon auto-start, ProtocolMismatchError
  alias.ts          AliasDefinition<I,O>, AliasContext, sentinel detection
  automation.ts     Automation manifest schema + helpers
  branch-guard.ts   Refuse-to-commit-on-main sentinel checks
  cache.ts          Tool cache types + helpers
  config.ts         Server config types and schemas
  cli-config.ts     ~/.mcp-cli/config.json read/write helpers
  constants.ts      Paths, defaults
  env.ts            ${VAR} and ${VAR:-default} expansion
  monitor-event.ts  Event bus payload types + `openEventStream` + formatter
  event-filter.ts   Server-side event filter expression types
  fs.ts             File system utilities (ensureDir, permissions)
  flock.ts          Cross-process file locking
  gh-client.ts      Lightweight `gh` CLI wrapper
  git.ts            Git plumbing helpers
  manifest.ts       `.mcx.yaml` parser + schema
  manifest-lock.ts  Lock-hash logic for `.mcx.lock`
  phase-source.ts   Phase source loading + bundling
  phase-transition.ts  Legal-transition validation
  model.ts          Model shortname → full model ID resolution
  plan.ts           Sprint plan parsing/serialization
  sprint-plan.ts    Sprint-N.md helpers
  sprint-state.ts   Active-sprint sentinel state
  schema-display.ts JSON Schema → compact TypeScript notation
  session-types.ts  Shared session state types (daemon, command, control)
  trace.ts          W3C Trace Context ID generation (trace-id, span-id)
  work-item.ts      Work-item types + state-key helpers

packages/daemon/src/
  main.ts                     Entry point
  index.ts                    Barrel export
  ipc-server.ts               HTTP-over-Unix-socket IPC server (main loop)
  server-pool.ts              Multiplexed server connection management
  event-bus.ts                Pub/sub fan-out for daemon events
  event-log.ts                Persistent event ring + replay
  monitor-executor.ts         Server-side filtering for `mcx monitor`
  monitor-runtime.ts          Runtime hooks for monitor projections
  derived-events.ts           Synthesize higher-level events from raw signals
  derived-rules.ts            Rule registry for derived-events
  work-items-server.ts        Virtual MCP server: `_work_items` tools + state DB
  automation-dispatcher.ts    Routes events to declared automation modules
  budget-watcher.ts           Cost/quota threshold emitters (cost.*, quota.*)
  quota.ts                    Quota status + 5h/30d windows
  plan-aggregator.ts          Cross-session plan rollups
  github/                     GH API client + PR/CI/comment pollers
  claude-server.ts            Virtual MCP server for Claude Code sessions
  claude-session-worker.ts    Worker hosting Claude session WS + MCP server
  claude-session/             Claude session state, WS server, NDJSON, perms
  codex-server.ts             Codex provider virtual server
  codex-session-worker.ts     Codex session worker
  codex-session/              Codex session machinery
  acp-server.ts               ACP provider virtual server
  acp-session-worker.ts       ACP session worker
  acp-session/                ACP session machinery
  opencode-server.ts          OpenCode provider virtual server
  opencode-session-worker.ts  OpenCode session worker
  opencode-session/           OpenCode session machinery
  mock-server.ts              Mock provider for tests
  mock-session-worker.ts      Mock session worker
  mock-session/               Mock session machinery
  alias-server.ts             Virtual MCP server exposing aliases as tools
  alias-server-worker.ts      Worker hosting alias MCP server
  alias-executor.ts           Phase-script / alias execution + ctx wiring
  mail-server.ts              Virtual MCP server: inter-session mail
  mail-events.ts              Mail-related event bus emitters
  metrics-server.ts           Virtual MCP server: `_metrics` tools
  metrics.ts                  Prometheus-style counters/gauges/histograms
  tracing-server.ts           Virtual MCP server: `_spans` tools
  site/                       Browser-mediated named HTTP calls (sites)
  site-server.ts              Virtual MCP server: site catalog + invocation
  site-worker.ts              Worker driving the harvested browser session
  worker-plugin.ts            Shared boilerplate for alias worker threads
  worker-transport.ts         MCP Transport adapters for Worker postMessage
  worker-control-message.ts   Control protocol between daemon and workers
  daemon-log.ts               Ring-buffer log capture (monkey-patches console)
  orphan-reaper.ts            Stale process cleanup on daemon startup
  restart-policy.ts           Server backoff + restart policy
  stderr-buffer.ts            Per-server circular ring buffer for stderr
  port-holder.ts              Port reservation for OAuth callbacks
  process-identity.ts         Daemon identity / single-instance guard
  worker-path.ts              Worker file path resolution (dev vs compiled)
  auth/                       OAuth, Keychain, token management
  config/                     Config file loading and watching
  db/                         SQLite state database
  handlers/                   IPC method handlers, dispatched by ipc-server
  tls/                        TLS helpers for HTTPS servers

packages/command/src/
  main.ts         Entry point (CLI dispatch — keep impl out of index.ts)
  index.ts        Barrel export
  alias-runner.ts Virtual module registration + Proxy + import() execution
  daemon-lifecycle.ts  Daemon auto-start, ipcCall wrapper, shutdown logic
  output.ts       Output formatting (JSON to stdout, errors to stderr)
  file-read.ts    Safe file reading with size limits
  parse.ts        Stdin reading and input parsing
  commands/       Per-command modules. Files (each exports one or more cmdX
                  handlers dispatched by main.ts):
                  add, agent, alias, auth, automation, claude, completions,
                  config, config-file, dump, export, gc, get, git-remote-helper,
                  import, install, logs, mail, mail-wait, memory, monitor, note,
                  phase, pr, registry-cmd, remove, run, scope, serve, serve-kill,
                  session-display, site, spans, spawn-args, telemetry, track
                  (track/tracked/untrack), tty, typegen, update, upgrade,
                  version, vfs, worktree-commands
  jq/             jq filtering support
  registry/       Registry client (transport + API)
  tty/            Terminal detection and adapters (iTerm, Kitty, etc.)
```

**Claude is the user of this project.** mcx is built by Claude, for Claude. Except for occasionally on `mcpctl`, there are no human users filing bug reports. That means every Claude — orchestrator, implementer, QA — is responsible for filing issues when problems are encountered. The quality of code, documentation, and organization directly benefit future Claude sessions.

**Every problem gets an issue.** If you notice something wrong, missing, or improvable during any phase — file it immediately. "Not a blocker" is not a reason to skip filing. Issues are how the team tracks and prioritizes work. Unfiled problems are invisible problems.

Examples of things that must be filed:
- A flag or command you tried that didn't work or isn't supported
- Test gaps discovered during QA
- Flaky tests (even if they pass on retry)
- Edge cases the implementation missed
- Performance concerns
- DX papercuts (confusing errors, missing flags, bad defaults)
- Bugs in adjacent code discovered while reading
- Missing documentation or misleading help text

Usability issues (daemon bugs, connection, etc) are P1 and take priority over all other work.