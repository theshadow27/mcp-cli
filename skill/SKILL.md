# MCP CLI — Context-Free MCP Tool Access

Use the `mcx` CLI via Bash instead of native MCP tools. This eliminates ~12,000 tokens of tool definitions per server from every conversation context.

## When to Use This

Use `mcx` CLI when calling MCP server tools (Atlassian, Coralogix, etc.). Use native MCP tools only when `mcx` CLI is unavailable or for interactive/streaming use cases.

**Trigger words:** atlassian, confluence, jira, coralogix, mcp server, mcp tool

## Quick Reference

```bash
# Discovery
mcx ls                                    # list servers + tool counts
mcx ls <server>                           # list tools for a server
mcx info <server> <tool>                  # TypeScript-notation schema
mcx grep <pattern>                        # search tools across all servers
mcx search <query>                        # search local tools, then registry

# Invocation
mcx call <server> <tool> '<json>'         # call a tool, JSON to stdout
mcx call <server> <tool> '<json>' --jq '.field'  # client-side jq filter
mcx call <server> <tool> '<json>' --full  # bypass output size protection

# Session Management
mcx claude spawn --task "..."             # start a Claude Code session
mcx claude ls                             # list active sessions
mcx claude send <session> <msg>           # send follow-up prompt
mcx claude bye <session>                  # end a session
mcx claude log <session>                  # view session transcript
mcx claude wait <session>                 # wait for session to idle
mcx claude interrupt <session>            # interrupt a running session
mcx mail -H                               # list inter-session message headers
mcx mail -s "subject" <recipient>         # send message (body from stdin)

# Server Management
mcx status                                # daemon health + server status
mcx restart [server]                      # reconnect server(s)
mcx daemon restart                        # restart the daemon
mcx daemon shutdown                       # stop the daemon
mcx logs <server>                         # view server stderr output
mcx install <server>                      # install server from registry
mcx config show                           # resolved config
```

## Common Patterns

### Jira

```bash
# Search issues
mcx call atlassian searchJiraIssuesUsingJql '{"cloudId":"CLOUD_ID","jql":"assignee = currentUser() AND sprint in openSprints()","fields":["summary","status","priority"]}'

# Get issue details
mcx call atlassian getJiraIssue '{"cloudId":"CLOUD_ID","issueIdOrKey":"PROJ-123"}'

# Get cloudId first if unknown
mcx call atlassian getAccessibleAtlassianResources '{}'
```

### Confluence

```bash
# Get page content
mcx call atlassian getConfluencePage '{"cloudId":"CLOUD_ID","pageId":"123456","contentFormat":"markdown"}'

# Search pages
mcx call atlassian searchConfluenceUsingCql '{"cloudId":"CLOUD_ID","cql":"title ~ \"search term\" AND type = page"}'
```

### Coralogix

```bash
# Get current time
mcx call coralogix-server get_datetime '{}'

# Query logs
mcx call coralogix-server get_logs '{"query":"source logs | filter $m.severity == ERROR","start_date":"2025-01-01T00:00:00Z","end_date":"2025-01-01T01:00:00Z"}'
```

## Aliases

Aliases are TypeScript scripts that compose multiple MCP tool calls. Instead of calling tools one-at-a-time (expensive in context tokens), write a script that Bun executes natively. Scripts import `{ mcp, args }` from a virtual `"mcp-cli"` module.

```bash
# Save an alias from a file
mcx alias save get-page @get-page.ts

# Save from stdin (how Claude should write aliases)
mcx alias save get-page - << 'TS'
import { mcp, args } from "mcp-cli";
const page = await mcp.atlassian.getConfluencePage({
  cloudId: args.cloud, pageId: args.id, contentFormat: "markdown"
});
console.log(page);
TS

# Run an alias
mcx run get-page --cloud CLOUD_ID --id 12345
mcx get-page --cloud CLOUD_ID --id 12345    # shorthand

# Manage aliases
mcx alias ls                                 # list all
mcx alias show <name>                        # print source
mcx alias edit <name>                        # open in $EDITOR
mcx alias rm <name>                          # delete
```

### Virtual Module API

Alias scripts `import { mcp, args, file, json } from "mcp-cli"` which provides:

- **`mcp`** — Proxy object: `mcp.<server>.<tool>(args)` calls a tool and returns unwrapped content (parsed JSON or text, not the MCP envelope)
- **`args`** — `Record<string, string>` of `--key value` CLI pairs
- **`file(path)`** — Read a file as text
- **`json(path)`** — Read and parse a JSON file

The import is auto-prepended if omitted, so simple scripts can skip it.

## Tips

- **Get cloudId**: Run `mcx call atlassian getAccessibleAtlassianResources '{}'` first to get the cloudId needed for Jira/Confluence calls.
- **Pipe to jq**: All output is JSON to stdout. Use `| jq .` for readability, `| jq '.field'` to extract specific fields.
- **Discover tools**: Use `mcx grep <pattern>` to find tools by name or description across all servers.
- **Check schemas**: Use `mcx info <server> <tool>` to see exact parameter types before calling.
- **Daemon auto-starts**: The daemon starts automatically on first `mcx` command. No setup needed.
- **Config**: Reads `~/.claude.json` and `.mcp.json` — same servers as Claude Code, zero extra config.
- **Prefer aliases for multi-step workflows**: If a task requires 2+ MCP tool calls, save it as an alias to reduce context token overhead and enable reuse.
