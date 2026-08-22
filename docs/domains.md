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
mcx domain show <name>                # resolve to host + path
mcx domain which [path]               # reverse lookup — which domain owns this path?
mcx domain rename <old> <new>
mcx domain rm <name>
```

Row: `id`, `name`, `host`, `path`, `created_at`. Nothing else.

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

### Lifecycle of a domain worker

`packages/daemon/src/domain-supervisor.ts` owns one worker per domain; the daemon owns
the supervisor and stays up regardless of what any worker does.

- **Spawned lazily, on first use** — not at daemon start. A domain row is a name bound to
  a location and nothing else; spawning per row at startup would make "registered" mean
  "running" and give the row the state column this table deliberately lacks. It is also
  the only policy that survives the host move: for a domain with a `host`, you connect
  when you need it, because "start it at daemon start" is not something you can do.
- **Removal is not lazy**, because nothing calls into a deleted domain and so nothing
  would notice. `DomainSupervisor.sync()` reconciles running workers against the table on
  the daemon's existing 30s tick: a removed domain loses its worker, and a **moved** one
  loses it too — the next use starts a fresh worker at the new location.
- **A rename costs nothing.** A worker is bound to `host` + `path` + `id`, and a rename
  changes none of them, so the running worker is kept and only the supervisor's view of it
  is updated (`domainRestartRequired`). This is deliberate and was briefly wrong: comparing
  the whole row meant `mcx domain rename` silently killed a worker, which once #3044 moves
  project execution here would abort a running phase for a cosmetic edit.
- **Restarts run under `restart-policy.ts`** with the same backoff and crash budget as
  every other worker. A restart re-reads the `domains` row rather than replaying the
  snapshot it started with, and a worker whose row has vanished is *not* restarted.
- **Nothing in a worker survives a restart.** A restart and a move to another host are
  the same event from the worker's point of view, and memory does not move. State that
  must survive belongs in the database.
- **A caller can tell "coming back" from "gone".** `DomainSupervisor.status()` returns a
  discriminated union — `no-such-domain` does not even carry a domain to act on — so the
  retryable and permanent cases cannot be conflated by reading an error string.

### The worker is addressed, never shared

The daemon reaches a worker through a `DomainLink` (`domain-link.ts`): control messages
one way, MCP JSON-RPC over the same link, failure as an event. A Bun Worker today, a
socket when the domain grows a `host` — [`agent-protocol.md`](agent-protocol.md) §2.1
carries the message schemas. Nothing in that interface may assume in-process delivery:
no shared references, no synchronous call-and-return, and every message is checked with
`assertWireSafe` so a value that survives structured clone but not JSON fails at the send.

**A domain worker serves no HTTP, and that is verified rather than asserted.** Two
layers, because sealing alone is not enough:

- The listener entry points are removed from the worker's global as an *import side
  effect* (`domain/autoseal.ts`, the worker's first import), so the seal precedes the
  worker's own import graph. Sealing later would leave any module that had already
  copied `Bun.serve` into a variable holding a working reference.
- At bind time the worker **attempts to listen** and refuses to start if a port opens.
  `domain_info` reports `guards: { http: "sealed" }` only on the strength of that
  attempt — a marker would let #3045's rule pass on a worker that can listen.

`node:http`/`node:net`/`node:dgram`/`node:http2`/`node:tls` namespaces cannot be
redefined at all, so those are closed by the static rule in #3045, not here.

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
