# @mcp-cli/permissions

Provider-neutral permission evaluation engine for agent sessions.

## Overview

This package extracts the permission matching logic that was previously embedded in `packages/daemon/src/claude-session/permission-router.ts` into a standalone, provider-agnostic package. All agent providers (Claude, Codex, OpenCode, ACP) use this to evaluate `can_use_tool` requests.

## Key Concepts

### Rule Format

Rules use the `Tool(pattern)` format from Claude Code's settings:

```
"Read"                  → exact tool match (all Read calls)
"Bash(git:*)"           → wildcard: command starts with "git "
"Bash(bun test)"        → exact: command is literally "bun test"
"Bash(ls /foo/*)"       → exact: the * is a bash glob, NOT a wildcard
"Read(src/**/*.ts)"     → file glob: matches TypeScript files in src/
"mcp__echo__echo"       → MCP tool name (exact match)
```

### Wildcard Marker

**Only `:*` is a wildcard.** Bare `*` is a valid bash character (like `ls /foo/*`) and is treated as literal. The `:*` suffix is Claude Code's native format meaning "this prefix with any arguments".

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

## Rules

- Zero external dependencies — uses only Bun built-ins
- 100% line coverage is the target
- Test with real-world patterns from Claude Code settings files
