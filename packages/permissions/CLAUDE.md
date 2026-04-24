# @mcp-cli/permissions

Provider-neutral permission evaluation engine for agent sessions.

## Overview

This package extracts the permission matching logic that was previously embedded in `packages/daemon/src/claude-session/permission-router.ts` into a standalone, provider-agnostic package. All agent providers (Claude, Codex, OpenCode, ACP) use this to evaluate `can_use_tool` requests.

## Key Concepts

### Rule Format

Rules use the `Tool(pattern)` format from Claude Code's settings:

```
"Read"                       → exact tool match (all Read calls)
"Bash(git:*)"                → wildcard: command starts with "git "
"Bash(bun test)"             → exact: command is literally "bun test"
"Bash(ls /foo/*)"            → exact: the * is a bash glob, NOT a wildcard
"Read(src/**/*.ts)"          → file glob: matches TypeScript files in src/
"mcp__echo__echo"            → MCP tool name (exact match)
"mcp__atlassian__*"          → MCP tool wildcard: all tools from atlassian server
"mcp__*"                     → MCP tool wildcard: all tools from any MCP server
```

### Wildcard Markers

**`:*` is the argument wildcard.** Bare `*` in a Bash argument pattern is a valid bash glob character (like `ls /foo/*`) and is treated as literal. The `:*` suffix is Claude Code's native format meaning "this prefix with any arguments".

**`__*` is the tool-name wildcard.** Appending `__*` to an MCP tool prefix matches all tools whose name starts with that prefix. This maps to MCP's `mcp__server__tool` naming convention:

- `mcp__atlassian__*` → allows every tool from the `atlassian` MCP server
- `mcp__*` → allows every MCP tool from any server

Only the `__*` suffix triggers prefix matching on tool names. A bare `*` at any other position (e.g., `Read*`) is not a wildcard and will only match the literal tool name `"Read*"` (which no real tool is named).

Deny rules with `__*` wildcards work symmetrically — a server-level deny (`mcp__atlassian__*`) combined with a broader allow (`mcp__*`) will block all atlassian tools via the standard first-deny-wins logic.

### Evaluation Semantics

1. Deny rules take precedence (first deny wins)
2. Then allow rules (first allow wins)
3. No match → fail-closed (deny)

### Compound Command Safety

Wildcard/prefix rules reject compound commands (`&&`, `||`, `;`, `|`). This prevents `Bash(git:*)` from matching `git status && rm -rf /`.

## Files

```
src/
  rule.ts           PermissionRule type, parsePattern(), toArgPrefix(), isWildcardPattern()
  bash-matcher.ts   Bash command matching: prefix, exact, compound rejection
  file-matcher.ts   File path glob matching (Bun.Glob)
  evaluator.ts      evaluate(rules, request) → PermissionDecision
  index.ts          Barrel export
  *.spec.ts         Tests for each module
```

## Usage

```typescript
import { evaluate, type PermissionRule } from "@mcp-cli/permissions";

const rules: PermissionRule[] = [
  { tool: "Read", action: "allow" },
  { tool: "Bash(git:*)", action: "allow" },
  { tool: "Bash(rm:*)", action: "deny" },
];

const decision = evaluate(rules, {
  toolName: "Bash",
  input: { command: "git push origin main" },
});
// → { allow: true, updatedInput: { command: "git push origin main" } }
```

## Testing

```bash
bun test packages/permissions/    # run tests
```

## Threat Model

**These rules are cooperative guardrails, not security boundaries.**

The permission engine is designed to prevent a well-intentioned agent from accidentally running a command outside its allowed scope. It assumes the agent is not actively trying to escape constraints.

### What the rules defend against

- An agent mistakenly calling a tool it wasn't meant to use
- Accidental execution of commands outside an allowed prefix (e.g., running `git push` when only `git log` should be permitted)
- Drift beyond the intended operation scope in automated pipelines

### Known limitations (not defended against)

1. **Command substitution bypass**: Prefix rules like `Bash(git:*)` block compound operators (`&&`, `||`, `;`, `|`) but an agent can still embed a subshell via `$(...)` in a non-prefix position — e.g., `git log $(rm -rf /)` would pass the prefix check because the command starts with `git `. An adversarial agent can exploit this.

2. **Compound detector false positives**: The shell lexer respects single/double quoting, so `git commit -m "fix: don't use || here"` correctly passes. However, the lexer is not a full POSIX parser — unusual quoting edge cases or heredocs may produce unexpected results.

3. **Non-standard field names**: The evaluator checks `command`, `cmd`, and `script` for Bash-like tools, and `file_path`, `path`, `filePath` for file tools. A tool implementation using a different field name would bypass deny rules entirely — the rule would simply not match.

4. **No runtime enforcement**: Rules are evaluated at `can_use_tool` request time, before the tool runs. There is no sandbox or OS-level enforcement. If the agent bypasses the permission check (e.g., by calling the tool directly), no rule applies.

### Consequence

Do not rely on this package to constrain an adversarial agent. If you need hard isolation, use OS-level sandboxing (seccomp, containers, etc.) in addition to these rules.

## Rules

- Zero external dependencies — uses only Bun built-ins
- 100% line coverage is the target
- Test with real-world patterns from Claude Code settings files
