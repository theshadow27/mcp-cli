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
bun dev:mcp -- ls            # run CLI directly
bun dev:mcp -- call atlassian search '{"query":"test"}'
```

## Architecture

```
packages/
  core/      → Shared types, IPC protocol, config types, env expansion
  daemon/    → mcpd: background daemon managing MCP server connections
  command/   → mcp: fast CLI that talks to daemon via Unix socket
  control/   → mcpctl: TUI for daemon status and auth management
```

**Build output:** `dist/mcpd`, `dist/mcp`, `dist/mcpctl` via `bun build --compile`

**Single prod dependency:** `@modelcontextprotocol/sdk`

**Runtime state:** `~/.mcp-cli/` — SQLite db, aliases, PID file, socket

## Key Patterns

- **IPC**: Unix socket at `~/.mcp-cli/mcpd.sock`, NDJSON protocol
- **Config**: reads Claude Code's `~/.claude.json` + `.mcp.json` natively
- **Transports**: stdio (command+args), HTTP (StreamableHTTP), SSE
- **Auth**: macOS Keychain reader (Claude Code tokens) → SQLite → env vars
- **Aliases**: TypeScript scripts in `~/.mcp-cli/aliases/`, executed by Bun virtual module `"mcp-cli"`. Metadata in SQLite `aliases` table. Scripts get `mcp` (Proxy → IPC → daemon → MCP server), `args`, `file()`, `json()`. Import auto-prepended if missing.

## Rules

- Bun all the way — no Node.js compat shims
- `bun:sqlite` for persistence — zero external deps
- Never use `any` — strict TypeScript
- Tests: `*.spec.ts`, import from `bun:test`
- Never use `mock.module()` — it pollutes Bun's global module registry across test files. Use dependency injection (optional constructor/function params) instead.
- Keep binaries lean — fast startup matters (<50ms for `mcp call`)
- JSON output to stdout, errors/status to stderr

## Project Structure

```
packages/core/src/
  ipc.ts          IPC protocol types (IpcRequest, IpcResponse, IpcMethod)
  config.ts       Server config types and schemas
  constants.ts    Paths, defaults
  env.ts          ${VAR} and ${VAR:-default} expansion

packages/daemon/src/
  index.ts        Entry point
  daemon.ts       Main daemon loop
  server-pool.ts  Multiplexed server connection management
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
