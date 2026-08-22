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

`add` refuses a duplicate name, and refuses a location that is **exactly** another domain's
`[host:]path`, naming it. Exactly — not "inside": **nesting is legal and expected**.
Registering both `~/github` and `~/github/mcp-cli` is the case the longest-prefix rule below
exists for, and refusing the inner one would remove the only thing that rule has to decide.
"Owns" elsewhere in this document means the prefix relation; here it means equality, and the
two are not the same test.

`rename` changes the name and nothing else **in the table**: `id` and `path` are untouched,
so every `domain_id` reference and every `which` answer survives it. That is a statement
about the row, not a claim that a rename is free everywhere — anything currently holding the
old name (a running domain worker, log correlation, an MCP handshake identity) still sees a
change. What a rename does to a running worker is the worker section's to state, not this
one's.

`rm` **refuses** while dependent rows exist and reports the counts per table; `--force`
cascades. Silently orphaning a thousand work items because a name was typed twice is not a
recoverable state, so the refusal is the default and the cascade is the flag.

`--cascade` is accepted as an exact synonym for `--force`, because `StateDb.deleteDomain`'s
own docstring names the option `--cascade` while this command's issue specified `--force`.
Documented rather than left implicit, and asserted as an equality in
`domain.spec.ts` rather than as two tests that separately expect the same thing — two
spellings of one destructive flag are only safe while something compares them to each other.
There is no third spelling: `parseFlags` rejects any flag it was not told about, so an
invented `--all` or `--scoped` on this command exits non-zero instead of quietly leaving a
default in place.

`import --force` **re-arms** the one-shot legacy import (#3034) — it clears the marker and
the import itself runs at the next daemon start. It does not import in place, and that is
not a convenience choice:

- The import is positioned at daemon startup **ahead of** `reapOrphanedSessions`,
  `restoreActiveSessions`, the pollers and the event bus. Landing `agent_sessions` rows
  after the reaper has run surfaces dead sessions as live until the next restart, and a
  printed "restart the daemon" line is an instruction, not a guarantee.
- It **refuses unless the database is empty** across every table the import *writes* —
  `IMPORT_WRITTEN_TABLES`, which is the copied set plus `domains`, because
  `importScopesAsDomains` writes that one too. Deriving the guard from the copied set alone
  reproduced the very defect the guard exists to close: a second table set maintained by
  omission, reporting EMPTY over a target already holding `domains` rows. The spec pins this
  behaviourally — a real import runs and every table that gained rows must be a member.
  `INSERT OR IGNORE` over AUTOINCREMENT surrogate keys (`monitor_events.seq`, `mail.id`)
  silently drops every legacy row whose id the target already reallocated, permanently, on a
  run that would otherwise report success.
- The daemon publishes `daemon.restarted` into `monitor_events` before it accepts its first
  request, so an in-flight forced import would be refused every time anyway.

The full recovery, which the daemon prints with the real paths it opened. **The order is
load-bearing**: the target is opened in WAL mode, so copying it while the daemon is live
takes the main file without the un-checkpointed `-wal` — a backup missing the most recent
transactions, in the one step whose entire job is to be the rollback. Shutting down first
checkpoints WAL into the main file and makes the single-file copy valid.

```bash
mcx domain import --force        # clears the marker (idempotent — safe to re-run)
mcx shutdown                     # checkpoints WAL, so the next line is a real backup
cp ~/.mcp-cli/mcx.db ~/.mcp-cli/mcx.db.bak
rm ~/.mcp-cli/mcx.db
mcx status                       # starts the daemon; the import runs at boot
```

A remote path must be absolute or `~`-rooted. `mcx domain add weird a:b` is refused rather
than registered at relative path `b` on a host called `a` — `a` is a perfectly valid
hostname, so nothing else would have caught it, and one relative row breaks `which` for
*every* query because the resolver normalizes each row inside its loop.

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
mcx monitor    -d phoenix
```

### Tables are a wall; the event stream is a filter

The two are not the same, and the difference is deliberate.

**Tables partition.** `alias_state` — the store behind `ctx.state` in alias and phase
scripts, and behind automation's per-work-item snapshot — is keyed
`(domain_id, repo_root, namespace, key)`. Two domains hold the same
`(namespace, key)` without seeing each other, and there is no read that spans them.
The domain is **derived server-side** from the caller's repo root, never sent as an
IPC parameter: a client-supplied partition key is one any script could change to read
another project's state.

**Events filter.** Every event carries a `domainId` — stamped once, in
`EventBus.publish`, from the producer's `repoRoot` — and `monitor_events` indexes it,
so `mcx monitor -d phoenix --since <seq>` replays one domain without scanning the
others. But a subscriber that omits `-d` still sees everything: the daemon-wide stream
is a real use case (`mcpctl`, an operator watching the whole box), and a wall there
would break it.

Two consequences worth knowing:

- An event with **no** domain (mail, quota, heartbeats, anything the daemon does on its
  own behalf) does **not** pass `-d phoenix`. Unlike `--repo`, which lets un-scoped
  events through, `-d` means "phoenix's events" — attributing daemon-wide state to one
  project is worse than omitting it.
- `-d` **replaces** the implicit cwd repo scope rather than stacking with it. Domains
  supersede `mcx scope`; `mcx monitor -d phoenix` from an unrelated directory has to
  show phoenix, not an empty stream that reads like a quiet domain. An explicit
  `--repo` still narrows further.

An unregistered domain name is an **error**, not an empty stream — for the same reason
`mcx domain which` outside every domain is an error rather than a guess.

## Mail

Mail addressing is the domain table's other user:

```bash
mcx mail send orchestrator          "..."   # local to this domain
mcx mail send orchestrator@phoenix  "..."   # explicit domain
```

A bare name resolves within the sender's domain. `user@domain` resolves through the
domains table, which is what makes the same syntax work unchanged when `phoenix`
moves to another host.
