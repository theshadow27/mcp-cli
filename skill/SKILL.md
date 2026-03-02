# MCP CLI — Context-Free MCP Tool Access

Use the `mcp` CLI via Bash instead of native MCP tools. This eliminates ~12,000 tokens of tool definitions per server from every conversation context.

## When to Use This

Use `mcp` CLI when calling MCP server tools (Atlassian, Coralogix, etc.). Use native MCP tools only when `mcp` CLI is unavailable or for interactive/streaming use cases.

**Trigger words:** atlassian, confluence, jira, coralogix, mcp server, mcp tool

## Quick Reference

```bash
# Discovery
mcp ls                                    # list servers + tool counts
mcp ls <server>                           # list tools for a server
mcp info <server> <tool>                  # TypeScript-notation schema
mcp grep <pattern>                        # search tools across all servers

# Invocation
mcp call <server> <tool> '<json>'         # call a tool, JSON to stdout
mcp call <server> <tool> '<json>' | jq .  # pretty-print result

# Management
mcp status                                # daemon health + server status
mcp restart [server]                      # reconnect server(s)
mcp config show                           # resolved config
```

## Common Patterns

### Jira

```bash
# Search issues
mcp call atlassian searchJiraIssuesUsingJql '{"cloudId":"CLOUD_ID","jql":"assignee = currentUser() AND sprint in openSprints()","fields":["summary","status","priority"]}'

# Get issue details
mcp call atlassian getJiraIssue '{"cloudId":"CLOUD_ID","issueIdOrKey":"PROJ-123"}'

# Get cloudId first if unknown
mcp call atlassian getAccessibleAtlassianResources '{}'
```

### Confluence

```bash
# Get page content
mcp call atlassian getConfluencePage '{"cloudId":"CLOUD_ID","pageId":"123456","contentFormat":"markdown"}'

# Search pages
mcp call atlassian searchConfluenceUsingCql '{"cloudId":"CLOUD_ID","cql":"title ~ \"search term\" AND type = page"}'
```

### Coralogix

```bash
# Get current time
mcp call coralogix-server get_datetime '{}'

# Query logs
mcp call coralogix-server get_logs '{"query":"source logs | filter $m.severity == ERROR","start_date":"2025-01-01T00:00:00Z","end_date":"2025-01-01T01:00:00Z"}'
```

## Aliases

Aliases are TypeScript scripts that compose multiple MCP tool calls. Instead of calling tools one-at-a-time (expensive in context tokens), write a script that Bun executes natively. Scripts import `{ mcp, args }` from a virtual `"mcp-cli"` module.

```bash
# Save an alias from a file
mcp alias save get-page @get-page.ts

# Save from stdin (how Claude should write aliases)
mcp alias save get-page - << 'TS'
import { mcp, args } from "mcp-cli";
const page = await mcp.atlassian.getConfluencePage({
  cloudId: args.cloud, pageId: args.id, contentFormat: "markdown"
});
console.log(page);
TS

# Run an alias
mcp run get-page --cloud CLOUD_ID --id 12345
mcp get-page --cloud CLOUD_ID --id 12345    # shorthand

# Manage aliases
mcp alias ls                                 # list all
mcp alias show <name>                        # print source
mcp alias edit <name>                        # open in $EDITOR
mcp alias rm <name>                          # delete
```

### Virtual Module API

Alias scripts `import { mcp, args, file, json } from "mcp-cli"` which provides:

- **`mcp`** — Proxy object: `mcp.<server>.<tool>(args)` calls a tool and returns unwrapped content (parsed JSON or text, not the MCP envelope)
- **`args`** — `Record<string, string>` of `--key value` CLI pairs
- **`file(path)`** — Read a file as text
- **`json(path)`** — Read and parse a JSON file

The import is auto-prepended if omitted, so simple scripts can skip it.

## Tips

- **Get cloudId**: Run `mcp call atlassian getAccessibleAtlassianResources '{}'` first to get the cloudId needed for Jira/Confluence calls.
- **Pipe to jq**: All output is JSON to stdout. Use `| jq .` for readability, `| jq '.field'` to extract specific fields.
- **Discover tools**: Use `mcp grep <pattern>` to find tools by name or description across all servers.
- **Check schemas**: Use `mcp info <server> <tool>` to see exact parameter types before calling.
- **Daemon auto-starts**: The daemon starts automatically on first `mcp` command. No setup needed.
- **Config**: Reads `~/.claude.json` and `.mcp.json` — same servers as Claude Code, zero extra config.
- **Prefer aliases for multi-step workflows**: If a task requires 2+ MCP tool calls, save it as an alias to reduce context token overhead and enable reuse.
