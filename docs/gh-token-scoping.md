# Scoped GitHub credentials for spawned sessions

The daemon spawns every Claude session with `{ ...process.env, ...overrides }`, so a
worker inherits whatever `GH_TOKEN` / `GITHUB_TOKEN` the orchestrator's shell carried —
usually an admin credential that can `gh pr merge --admin`, delete a ruleset, or
force-push `main`. Containment (#1441) bounds a worker's filesystem blast radius; this
bounds its GitHub API reach (#1510).

## Configuring the pair

Write `~/.mcp-cli/tokens.json`, **mode 0600** — a group- or world-readable file is
ignored, because a credential everything on the box can read is not scoped:

```bash
umask 077
cat > ~/.mcp-cli/tokens.json <<'EOF'
{
  "worker": "<fine-grained PAT: contents+PR write, no admin>",
  "orchestrator": "<admin PAT: rulesets, branch protection, releases>"
}
EOF
chmod 600 ~/.mcp-cli/tokens.json
```

`MCX_GH_TOKEN_WORKER` / `MCX_GH_TOKEN_ORCHESTRATOR` work as a fallback for keys the file
does not set (the file wins per key). Both source variables are stripped from the child
environment so admin material cannot ride along under a different name.

## The policy

`packages/daemon/src/claude-session/gh-token.ts` owns the whole table as one pure
function, `resolveSpawnGhToken(role, tokens)`. A **worktree spawn is a worker**; anything
else runs in the orchestrator's own checkout and keeps the trusted tier.

| role | worker token | admin token | outcome |
|---|---|---|---|
| worker | set | any | `scoped` — worker token injected into `GH_TOKEN` + `GITHUB_TOKEN` |
| worker | unset | set | `denied` — inherited credentials stripped; the admin token is never shared |
| worker | unset | unset | `inherited` — legacy single-token behaviour, warned once per daemon |
| orchestrator | any | set | `orchestrator` — admin token injected |
| orchestrator | any | unset | `inherited` |

There is no input for which a worker decision carries the admin token. That is the
security property, and it is a unit-tested function rather than a convention around an
env assignment.

## Handling of token material

Token strings reach exactly one place: the child process environment. They are never
written to SQLite, the daemon log ring buffer, stderr, an error message, or an event
payload — only the decision's `mode` and its secret-free `reason` are logged.
`ws-server-gh-token.spec.ts` asserts this against every daemon-side sink.

## Not yet implemented

- `mcx auth set-worker` / `set-orchestrator` and `mcx auth status` surfacing the pair —
  configuration is file/env only for now.
- Per-repo scoping and per-sprint rotation (needs a GitHub App).
- The same policy for the non-Claude session providers (codex, acp, opencode).
