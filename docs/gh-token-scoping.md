# Scoped GitHub credentials for spawned sessions

The daemon spawns every Claude session with `{ ...process.env, ...overrides }`, so a
child inherits whatever GitHub credential the daemon's environment carried — usually an
admin credential that can `gh pr merge --admin`, delete a ruleset, or force-push `main`.
Containment (#1441) bounds a worker's filesystem blast radius; this bounds its GitHub API
reach (#1510).

## Every spawned session is a worker

There is no orchestrator tier, and that is the point. The orchestrator is the process
*calling* `spawnClaude`; it is never the process being spawned, so a spawn request can
never tell the daemon that its child deserves admin. Keying the tier on a spawn flag —
`--worktree`, say — makes the boundary something a caller escalates past by *forgetting* a
flag, which `mcx claude resume` does unconditionally.

So the admin token has no code path into any child environment. The `orchestrator` key in
the tokens file is a **declaration**, not an injection source: its presence tells the
daemon "an admin credential exists on this box, never hand it down", which flips an
otherwise-unconfigured child from `inherited` to `denied`.

## Configuring the pair

Write `~/.mcp-cli/tokens.json`, **mode 0600**. Write it **atomically** — a spawn that
reads a half-written file is refused GitHub access (fail closed), so a plain `cat >`
redirect can deny a worker mid-sprint:

```bash
umask 077
cat > ~/.mcp-cli/tokens.json.tmp <<'EOF'
{
  "worker": "<fine-grained PAT: contents+PR write, no admin>",
  "orchestrator": "<admin PAT: rulesets, branch protection, releases>"
}
EOF
chmod 600 ~/.mcp-cli/tokens.json.tmp
mv ~/.mcp-cli/tokens.json.tmp ~/.mcp-cli/tokens.json   # atomic rename
```

`MCX_GH_TOKEN_WORKER` / `MCX_GH_TOKEN_ORCHESTRATOR` work as a fallback for keys the file
does not set (the file wins per key). They are **not** a fallback for a file that exists
but cannot be trusted — see below. Either var being *set to an unusable value* (blank,
embedded whitespace, a control character, over 4096 chars — all legal in a POSIX env var)
is a config error, not a miss: it denies every spawn, the same way the same value in the
file does. Silently dropping it would make a malformed declaration look identical to no
declaration at all, and "nothing declared" is the one input that inherits.

## The policy

`packages/daemon/src/claude-session/gh-token.ts` owns the whole table as one pure
function, `resolveSpawnGhToken(config, ctx)`.

| configuration | outcome |
|---|---|
| tokens file present but untrusted, or a source var set to an unusable value | `denied` — fail closed, error logged every spawn |
| worker token set | `scoped` — worker token injected, ambient fallback closed |
| only an `orchestrator` token declared | `denied` — no GitHub credential reachable |
| nothing configured | `inherited` — legacy single-token behaviour, warned once per daemon |

There is no input for which any decision's environment carries the admin token. That is
the security property, and it is a unit-tested function rather than a convention around an
env assignment.

## What `denied` actually removes

Clearing `GH_TOKEN` and `GITHUB_TOKEN` does not remove a credential — it *restores* the
ambient one. `gh` falls back to `~/.config/gh/hosts.yml`, and `git push` over HTTPS reaches
the same credential through `credential.helper` in `~/.gitconfig`. A control that reports
`denied` while a worker can still run `gh pr merge` is worse than no control, because it is
invisible.

Both `scoped` and `denied` therefore set, in the same override block:

- `GH_CONFIG_DIR` → `~/.mcp-cli/gh-isolated`, a directory holding no `hosts.yml`. Verified:
  `gh` reports "not logged into any GitHub hosts" for a missing or unwritable config
  directory — it does not fall back to `~/.config/gh`.
- `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` → reset the git
  credential-helper list (both the generic `credential.helper` and the URL-scoped
  `credential.https://github.com.helper` that `gh auth setup-git` writes), with the
  precedence of `git -c`. This is surgical where `GIT_CONFIG_GLOBAL=/dev/null` is not:
  identity and signing settings in `~/.gitconfig` survive, so a scoped worker can still
  commit.
- `GIT_TERMINAL_PROMPT=0` → fail fast rather than hang on a prompt the child has no
  terminal for.

`scoped` then re-adds `gh auth git-credential` as the **only** helper, so `git push`
resolves through the injected worker token — and through nothing else, including a `store`
or keychain helper holding an admin credential. `denied` leaves the list empty, so
`git push` and `gh` both fail cleanly.

### The child is told why

A real `denied` costs the child `gh pr create` and `git push`. Discovering that as a bare
401 is how a worker ends up working around the boundary, so the decision travels with it:

- `MCX_GH_CREDENTIALS` — `scoped` or `denied`
- `MCX_GH_CREDENTIALS_REASON` — the same secret-free reason string the daemon logs

## Failing closed

Every failure mode of reading `tokens.json` other than "no such file" is an **error**, and
an error resolves to `denied` with a loud, operator-facing message naming the path (and the
octal mode where relevant):

- mode 0644 — any editor writing under a default umask, `rsync` without `-p`, a backup
  restore
- a truncated read racing a non-atomic write
- a token with a stray space, a control character, or over 4096 characters
- a JSON object declaring neither key

Each of these previously degraded to ambient credentials while telling the operator
nothing. The env fallback deliberately does **not** rescue an untrusted file: the ambient
environment is exactly the admin credential the file was written to stop handing down.

The mode is checked with `fstat` on the open descriptor rather than `stat` on the path, so
the bytes validated and the bytes read are the same inode.

## Handling of token material

Token strings reach exactly one place: the child process environment. They are never
written to SQLite, the daemon log ring buffer, stderr, an error message, or an event
payload — only the decision's `mode` and its secret-free `reason` are logged.
`ws-server-gh-token.spec.ts` asserts this against every daemon-side sink, and asserts each
sink is non-empty first so the sweep cannot pass by vacuity.

## Observability

Every spawn emits `session.gh_credentials` on the event bus with `sessionId`, `mode`, and
`reason` — durable, because the daemon log ring evicts and a daemon here stays up for days.
A rejected tokens file also raises the event to `actionable` severity and logs an error on
**every** affected spawn; only the benign single-token warning is latched once per daemon.

```bash
mcx monitor --filter 'event == "session.gh_credentials"'
```

## Known limitations

- **Env vars are not a boundary between same-uid siblings.** `/proc/<pid>/environ` is
  readable by the owning user, and the daemon and every worker run as the same user, so a
  worker can read another's token directly. Closing that needs the credential brokered over
  the daemon's Unix socket as a `git-credential` helper, so it never materializes in a child
  env at all. Tracked separately.
- **A hostile child can unset these variables.** The isolation makes the ambient credential
  unreachable to `gh` and `git` as they are normally invoked; it is not a sandbox.
- **`~/.mcp-cli/gh-isolated` is shared across sessions.** A child that obtained a credential
  by other means could `gh auth login` into it and expose it to later spawns. Per-session
  isolation directories are the fix if that ever matters.

## Not yet implemented

- `mcx auth set-worker` / `set-orchestrator` and `mcx auth status` surfacing the pair —
  configuration is file/env only for now (#3114).
- The daemon's own `gh` path (`core/gh-client.ts`) still uses ambient credentials; it is not
  routed through the admin token.
- Per-repo scoping and per-sprint rotation (needs a GitHub App).
- The same policy for the non-Claude session providers (codex, acp, opencode) and the alias
  executor (#3108).
