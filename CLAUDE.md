# CLAUDE.md

MCP CLI — Model Context Preservation - call MCP server tools from the command line with zero context overhead, delegate to other Claude Code instances, and monitor operations. 

## Quick Reference

```bash
bun install                  # install deps
bun typecheck                # TypeScript validation
bun lint                     # lint + format
bun test                     # run tests
bun build                    # compile binaries to dist/

# Development
bun dev:daemon               # run daemon directly
bun dev:mcx -- ls            # run CLI directly
bun dev:mcx -- call atlassian search '{"query":"test"}'
```

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
- **Flaky test prevention**: see `test/CLAUDE.md` for required patterns. Never use `setTimeout` for waiting, never hardcode ports, always poll with deadlines instead of fixed delays.

## Project Structure

```
packages/core/src/
  index.ts          Barrel export
  ipc.ts            IPC protocol types (IpcRequest, IpcResponse, IpcMethod)
  ipc-client.ts     IPC client, daemon auto-start, ProtocolMismatchError
  alias.ts          AliasDefinition<I,O>, AliasContext, sentinel detection
  config.ts         Server config types and schemas
  cli-config.ts     ~/.mcp-cli/config.json read/write helpers
  constants.ts      Paths, defaults
  env.ts            ${VAR} and ${VAR:-default} expansion
  fs.ts             File system utilities (ensureDir, permissions)
  model.ts          Model shortname → full model ID resolution
  schema-display.ts JSON Schema → compact TypeScript notation
  session-types.ts  Shared session state types (daemon, command, control)
  trace.ts          W3C Trace Context ID generation (trace-id, span-id)

packages/daemon/src/
  index.ts                  Entry point
  ipc-server.ts             HTTP-over-Unix-socket IPC server (main loop)
  server-pool.ts            Multiplexed server connection management
  claude-server.ts          Virtual MCP server for Claude Code sessions
  claude-session-worker.ts  Worker hosting Claude session WS + MCP server
  alias-server.ts           Virtual MCP server exposing aliases as tools
  alias-server-worker.ts    Worker hosting alias MCP server
  alias-worker.ts           Worker for extracting defineAlias metadata
  worker-plugin.ts          Shared boilerplate for alias worker threads
  worker-transport.ts       MCP Transport adapters for Worker postMessage
  daemon-log.ts             Ring-buffer log capture (monkey-patches console)
  metrics.ts                Prometheus-style metrics collection (counters, gauges, histograms)
  orphan-reaper.ts           Stale process cleanup on daemon startup
  stderr-buffer.ts          Per-server circular ring buffer for stderr
  worker-path.ts             Worker file path resolution (dev vs compiled)
  claude-session/           Claude Code session management
    session-state.ts        Session state machine
    ws-server.ts            WebSocket server for SDK sessions
    permission-router.ts    Permission routing for can_use_tool requests
    ndjson.ts               NDJSON parser/serializer for WS protocol
    tools.ts                Shared tool definitions for _claude server
  auth/                     OAuth, Keychain, token management
  config/                   Config file loading and watching
  db/                       SQLite state database

packages/command/src/
  index.ts        Entry point, arg dispatch
  alias-runner.ts Virtual module registration + Proxy + import() execution
  output.ts       Output formatting (JSON to stdout, errors to stderr)
  file-read.ts    Safe file reading with size limits
  parse.ts        Stdin reading and input parsing
  commands/       call, ls, run, alias, mail, status, auth, config, claude,
                  serve, tty, install, completions, typegen, logs, version,
                  spans, registry-cmd, export, import, add, remove, get,
                  config-file
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