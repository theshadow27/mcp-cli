# CLAUDE.md

MCP CLI — call MCP server tools from the command line with zero context overhead.

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

## Project Structure

```
packages/core/src/
  ipc.ts          IPC protocol types (IpcRequest, IpcResponse, IpcMethod)
  alias.ts        AliasDefinition<I,O>, AliasContext, sentinel detection
  config.ts       Server config types and schemas
  constants.ts    Paths, defaults
  env.ts          ${VAR} and ${VAR:-default} expansion

packages/daemon/src/
  index.ts        Entry point
  daemon.ts       Main daemon loop
  server-pool.ts  Multiplexed server connection management
  alias-worker.ts Bun Worker for extracting defineAlias metadata
  transports/     Stdio, HTTP, SSE transport wrappers
  auth/           OAuth, Keychain, token management
  config/         Config file loading and merging
  db/             SQLite state database

packages/command/src/
  index.ts        Entry point, arg dispatch
  alias-runner.ts Bun virtual module registration + Proxy + import() execution
  commands/       call, ls, info, grep, run, alias, note, status, auth, config
  ipc/            Socket client, auto-start daemon
  output/         Formatting, schema display
```
