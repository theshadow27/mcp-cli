# Domains

A **domain** is a name bound to a location. That is all it is.

```bash
mcx domain add phoenix ~/github/phoenix-octovalve
mcx domain add phoenix boxen0010:~/github/phoenix-octovalve   # same command, later
```

The domains table is mcx's DNS: pure data, routing, and partitioning. Every partitioned
table in the daemon carries a `domain_id` column, and every command that acts on
something takes `-d <domain>`.

`domain_id` is deliberately **not** a declared `REFERENCES domains(id)` foreign key.
Rows written before a domain is resolved carry the sentinel `domain_id = 0`, which by
design has no `domains` row — a real FK would require seeding a phantom domain that
`mcx domain ls` would list and `mcx domain which` could match, which is a worse lie than
an undeclared constraint. (SQLite also leaves `PRAGMA foreign_keys` off by default, so a
declared FK here would enforce nothing anyway.)

Where the partition *is* enforced depends on whether the table has a natural key:

- **Six tables key on a value that repeats across projects** — an issue number, a branch,
  a PR number, an alias name, a state key — and for those `domain_id` is part of the
  PRIMARY KEY or of a UNIQUE index: `work_items`, `ci_run_states`, `alias_state`,
  `aliases`, `copilot_comment_state`, `derived_cursor`. Without it, two projects could not
  both have an issue #42, and the second domain to run `mcx phase install` would overwrite
  the first domain's phases.
- **Four tables key on a surrogate that is already globally unique**, so no cross-domain
  collision is possible and `domain_id` is for filtering rather than identity:
  `mail.id`, `work_item_transitions.id` and `monitor_events.seq` (AUTOINCREMENT rowids),
  and `agent_sessions.session_id` (a generated id).

`packages/daemon/src/db/domains.spec.ts` enforces both halves, and derives the set of
partitioned tables from the schema itself (`sqlite_master` ⋈ `pragma_table_info`) rather
than from a list — so a table added later cannot slip through unclassified.

Domains supersede `mcx scope`, which was the same idea stored as JSON sidecars in
`~/.mcp-cli/scopes/` with no partition role and no host component.

## What a domain row is not

A domain row has **no state column**. It does not know whether anything is running.
This is deliberate, and it is the reason there are three command families rather
than one:

| Family | Owns | Question it answers |
|---|---|---|
| `mcx domain` | names → locations | *where does `phoenix` live?* |
| `mcx loop` | the executor, the timer, the reducer | *is work being picked up?* |
| `mcx machine` *(later)* | host and hardware lifecycle | *is the box up?* |

`mcx machine` is **out of scope for this epic** and noted here only so the seam is left
open. It is the start of multi-node: once a domain can name a host, something has to be
able to bring that host up. Until then every domain is local and assumed up.

Collapsing these was tempting and would have been wrong. `mcx domain suspend` and
`mcx loop off` would mean nearly the same thing from the outside and completely
different things underneath — and two verbs for one state is exactly how sprint-loop
ended up marking in-flight items `parked` to keep the orchestrator off them, which
then propagated the lie into the tally and the tick.

A domain can be resolvable while its machine is down. A machine can be up while its
loop is off. Both are normal.

## `mcx domain` — the table

```bash
mcx domain add <name> [host:]<path>   # register
mcx domain ls [--json]                # list
mcx domain show <name> [--json]       # resolve to host + path
mcx domain which [path] [--json]      # reverse lookup — which domain owns this path?
mcx domain rename <old> <new>
mcx domain rm <name> [--force]
mcx domain import [--force]           # re-run the one-shot import from the legacy state.db
```

Row: `id`, `name`, `host`, `path`, `created_at`. Nothing else.

`~` and relative paths are expanded **at the CLI**, against the caller's home and cwd, and
only for a local domain — a host-bound path names a directory on another machine, where
this filesystem has no say, and is stored verbatim. The daemon rejects a relative local
path at the IPC boundary rather than anchoring it on its own cwd, which is a different
directory and would only misbehave after a restart.

`add` refuses a duplicate name and a location another domain already owns, naming it.
`rename` is a name change only: `id` and `path` are untouched, so every `domain_id`
reference and every `which` answer survives it.

`rm` **refuses** while dependent rows exist and reports the counts per table; `--force`
cascades. Silently orphaning a thousand work items because a name was typed twice is not a
recoverable state, so the refusal is the default and the cascade is the flag.

`import --force` **re-arms** the one-shot legacy import (#3034) — it clears the marker and
the import itself runs at the next daemon start. It does not import in place, and that is
not a convenience choice:

- The import is positioned at daemon startup **ahead of** `reapOrphanedSessions`,
  `restoreActiveSessions`, the pollers and the event bus. Landing `agent_sessions` rows
  after the reaper has run surfaces dead sessions as live until the next restart, and a
  printed "restart the daemon" line is an instruction, not a guarantee.
- It **refuses unless the database is empty** across every table in `IMPORTED_TABLES` — the
  same list the copy iterates, so the two cannot disagree. `INSERT OR IGNORE` over
  AUTOINCREMENT surrogate keys (`monitor_events.seq`, `mail.id`) silently drops every legacy
  row whose id the target already reallocated, permanently, on a run that would otherwise
  report success.
- The daemon publishes `daemon.restarted` into `monitor_events` before it accepts its first
  request, so an in-flight forced import would be refused every time anyway.

The full recovery, which the daemon prints with the real paths it opened:

```bash
cp ~/.mcp-cli/mcx.db ~/.mcp-cli/mcx.db.bak && rm ~/.mcp-cli/mcx.db
mcx domain import --force        # clears the marker
mcx shutdown                     # next start performs the import
```

The marker lives in the **legacy** `state.db`, deliberately, so it outlives `mcx.db` — which
is why deleting `mcx.db` alone is not a recovery. Without `--force` the command declines and
names the marker.

`host` is null for a local domain. When it is set, the daemon routes to a domain
server on that host instead of a local worker — same control protocol either way.

### Resolution

Commands that take `-d <domain>` default to `mcx domain which $PWD`, walking up to
the nearest registered domain. Outside any domain, `-d` is required and its absence
is an error, never a guess.

## `mcx machine` — deferred

Not in this epic. Recorded so the shape is not lost:

```bash
mcx machine status | start | stop | suspend | resume  -d phoenix
```

...driven by hooks a domain declares (`startup`, `shutdown`, `suspend`, `resume`), for the
case where a domain owns expensive infrastructure that should only run while the domain is
being worked — bring the GPUs up when the loop starts, park them when it idles.

This is multi-node's entry point, and it should be designed with multi-node rather than
ahead of it. Machine state would live in the machine subsystem, never as a column on the
domain.

## `mcx loop` — the executor

```bash
mcx loop status  -d phoenix
mcx loop on      -d phoenix
mcx loop off     -d phoenix
mcx loop pause   -d phoenix [--reason "..."] [--until <ts>]
mcx loop next    -d phoenix          # what would it pick up right now?
mcx loop why     -d phoenix          # why that, and what it passed over
mcx loop tick    -d phoenix          # run one iteration now, in the foreground
mcx loop install                     # install the OS unit that keeps mcpd alive
```

`on | off | pause` are three states, not two. Quota exhaustion and blocked-on-human
are auto-pauses that must auto-resume; `off` is a human decision that must not.
The switch is enforced at the daemon's spawn point, not advisory in a brief — a
running orchestrator cannot talk its way past it.

### `loop next` and `loop why`

Both call the domain's **reducer**, a function the project supplies:

```ts
// .claude/loop/select.ts
export function nextAction(state: LoopState): NextAction
```

The reducer is a function rather than a paragraph in a skill file because an
invariant written in prose is something an orchestrator can rationalize past at 2am
under context pressure. `mcx loop why` exists so that a reducer which stalls the
loop fails loudly instead of silently:

```
$ mcx loop why -d phoenix
picked   feedback/0007 — unread priority:now feedback preempts the queue
passed   items/03      — owner: human
passed   items/04      — blocked-on D-2026-08-21-waitlist-flip (decision open)
passed   items/07      — frontmatter parse error at line 4 (never runnable)
```

### `loop install`

Installs **one** OS unit — the supervisor for `mcpd` — not a cron entry per domain.
Every per-domain schedule is a timer inside the daemon, so the three things a cron
wrapper has to solve for itself (a lock, a PATH, a root) do not arise.

- **Linux**: a systemd *user* unit, `Restart=always`, plus `loginctl enable-linger`
  so it survives logout.
- **macOS**: a launchd plist with `KeepAlive`.

Both are configured sleep-aware — `Persistent=true` / `StartCalendarInterval`, which
fire missed work on wake rather than skipping it. Every sensor sweep runs from a
durable cursor for the same reason: on a laptop, arbitrary gaps are the normal case,
and "the last N hours" is always wrong across one.

## Workers

Two kinds, and they do not overlap:

- **A domain worker** runs project code — phases, automation, sensors, the reducer.
  One per domain. It does not serve HTTP.
- **The console worker** serves `mcpctl` on the web. One, for all domains. See
  [`console.md`](console.md).

Project code and the web server are separate processes because they fail differently and
one should not take the other with it.

Because a project must be **installed** before it runs — the same as phases today — the
console's page is built at install time with `Bun.build`. That typechecks every renderer
the project supplies and emits a bundle. The daemon never transpiles project TSX at request
time; by the time anything is served, the code has already been compiled once, under a
lockfile, with type errors surfaced at `mcx install` rather than in a browser.

## Everything else takes `-d`

```bash
mcx card ls    -d phoenix
mcx sensor ls  -d phoenix
mcx console browser
mcx claude ls  -d phoenix
```

## Mail

Mail addressing is the domain table's other user:

```bash
mcx mail send orchestrator          "..."   # local to this domain
mcx mail send orchestrator@phoenix  "..."   # explicit domain
```

A bare name resolves within the sender's domain. `user@domain` resolves through the
domains table, which is what makes the same syntax work unchanged when `phoenix`
moves to another host.
