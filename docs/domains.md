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

That last point used to have an exception: `mail.reply_to REFERENCES mail(id)` was the
schema's only declared foreign key, and nothing in `packages/daemon/src/db/` ever turned
enforcement on — so it read as a reply-integrity guarantee that a cross-domain
`mcx domain rm --force` could break silently. #3180 removes the clause from the schema
DDL, so databases created from now on declare nothing they do not enforce.

Databases created *before* that still carry the clause, and no migration removes it:
SQLite cannot drop a constraint in place, so doing so means rebuilding every user's
`mail` table to delete a declaration that no code path reads. The two shapes behave
identically until someone turns `PRAGMA foreign_keys` on — a separate decision with
implications well beyond mail, and the point at which that rebuild (plus a decision about
the already-dangling `reply_to` rows) becomes worth doing.

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
`~/.mcp-cli/scopes/` with no partition role and no host component. That command was
removed in v2.0.0 (#3042) — `mcx scope <anything>` now names its `mcx domain` replacement
and exits non-zero. The sidecars themselves are still read once, by the legacy import
below, and are left on disk.

## How a partitioned table is actually scoped

`work_items` is the worked example (#3037); every table that follows should copy its shape.

**The partition is the object, not an argument.** `WorkItemDb` owns migration and exposes
exactly one method — `forDomain(domainId)` — returning a handle on which every read and
write is already constrained. There is no unscoped query to forget to scope, because there
is no unscoped query. An optional `domainId` parameter with a default was tried first and is
precisely the shape that let `work_item_transitions.domain_id` ship with no writer at all.

**The caller's domain arrives out-of-band.** The `_work_items` virtual server takes its
domain from MCP `_meta`, which the daemon attaches after resolving the caller's cwd. `_meta`
is a sibling of `arguments` in the MCP request and the IPC schema strips unknown keys, so a
session cannot put a domain on the wire — and no tool's `inputSchema` mentions one, so no
model is ever shown a parameter that looks like it might widen the scope. The scope is
settled before the tool sees the call. (Spoofing the *cwd* is a different question and is
epic C's, not this layer's.)

**Ids are qualified, because they are guessable.** A work-item id is derived from what it
tracks (`#42`, `pr:7`, `branch:fix/foo`) and is the table's global primary key, so two
domains tracking issue 42 would collide on the key even though `(domain_id, issue_number)`
is unique. Inside a registered domain the id becomes `d<id>:<base>`; in the unassigned
partition it is unchanged, so an installation with no domains sees byte-identical ids to
before. Lookups accept either spelling and are filtered by `domain_id` either way, so a
shorter spelling never reaches further.

**"No domains" is not the default state, and code must not assume it is.** `importLegacyState`
runs on *every* daemon start, and `importScopesAsDomains` inserts a domain row for every
`~/.mcp-cli/scopes/*.json` sidecar — no user action required, independently of whether anyone
has run `mcx domain add` (#3035). Any box that ever used `mcx scope` therefore has domains
already. This is why an id must be treated as opaque: reconstructing one by formatting an
issue number produces the unqualified spelling, which addresses a different row than the
stored id and fails silently. Read ids from the database or a tool response and pass them
back unchanged.

**The check is a rule, not a convention.** `scripts/rules/domain-scoped-queries.rule.ts`
fails the build on a statement in a `@domain-partitioned` module that touches a table
declared with a `domain_id` column without constraining it. It derives the table list from
the schema rather than keeping a copy, and modules opt in as their behaviour is scoped.

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

**Mail is the one place a domain's name is stored outside this table**, and the rename
takes it along (#3247). A cross-domain message's stored `sender` is `local@domain-name`,
not `local@domain-id` — the whole point is a human-readable return address (see
"Cross-domain delivery" below) — so `rename` also rewrites every `mail.sender` stamped
`local@old` to `local@new`, in the **same transaction** as the name change. Either both
land or neither does; there is no window where mail is attributed to a name no domain
holds. That is a *data* migration, not a schema one — no version bump, nothing to run.

The suffix match is exact, not a `LIKE` pattern: a domain name may contain `_`, which LIKE
would treat as a wildcard, so renaming `alpha_b` would otherwise restamp mail from a
domain called `alphaXb` and redirect a third party's replies.

`rm` cannot do the same thing — the name is going away, not moving — so it **refuses**
instead. `rm` refuses while dependent rows exist and reports the counts per table, and it
refuses while any cross-domain message elsewhere still names this domain as its return
address, reporting that count separately. Silently orphaning a thousand work items because
a name was typed twice is not a recoverable state, so the refusal is the default and the
cascade is the flag.

`--force` treats the two reasons differently, and the difference is deliberate:

- **Dependent rows** (anything carrying this `domain_id`) are deleted with the domain.
- **Stamped return addresses are left exactly as they are**, and `rm` says so. They are
  rows in *other* domains' partitions: deleting them would be `mcx domain rm alpha
  --force` destroying `beta`'s inbox, which is the cross-partition write the whole
  partition rule exists to prevent. Stripping the `@alpha` qualifier instead would be
  worse than either — a bare sender re-parses as a mailbox in the *reader's* domain, so
  the reply would deliver somewhere nobody addressed.

So after a forced `rm`, replies to those messages keep failing loudly with `unknown domain
"alpha"` — and that error already names the domain and already says `register it with mcx
domain add`, which is the recovery: register a domain under the old name and the stamped
addresses resolve again. A tombstone sentinel (`local@<deleted:alpha>`) was considered and
rejected for exactly that reason — it would make the strand permanent in exchange for an
error message that says less.

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
*every* query because the resolver normalizes each row inside its loop. Since #3210 that is
also a `CHECK` on the table itself, so the row cannot be written by any route.

A **local** path must already exist. `mcx domain add phoenix ~/github/not-cloned-yet` is
refused, because canonicalization is a point-in-time answer: for a path that does not exist,
the resolver resolves the nearest existing ancestor and re-joins the rest *lexically*. Let
the missing segments appear later under a symlink — which is exactly what
`.claude/worktrees/` is — and the stored spelling no longer matches what a lookup computes,
so `mcx domain ls` shows the domain while `mcx domain which` reports "not inside any
registered domain" (#3210). A host-bound path is exempt: this filesystem has no say over
another machine's.

The marker lives in the **legacy** `state.db`, deliberately, so it outlives `mcx.db` — which
is why deleting `mcx.db` alone is not a recovery. Without `--force` the command declines and
names the marker.

`host` is null for a local domain. When it is set, the daemon routes to a domain
server on that host instead of a local worker — same control protocol either way.

### Resolution

Commands that take `-d <domain>` default to `mcx domain which $PWD`, walking up to
the nearest registered domain. Outside any domain, `-d` is required and its absence
is an error, never a guess.

### Nesting: resolution is longest-prefix, filtering is exact

A path resolves to the **innermost** domain containing it. But a row's `domain_id`
names exactly one domain, and filtering compares that id for equality — it does not
walk outward. Register both `~/github` and `~/github/mcp-cli`, and a session started
in `mcp-cli` belongs to `mcp-cli`; `mcx claude ls -d github` will **not** list it.

This is deliberate. A domain is a partition, and a row in two partitions is not a
partition. Making a listing walk outward would mean the answer to "which sessions are
in this domain?" depends on which other domains happen to be registered, and the
`domains` table is meant to be pure routing data. If you want an outer domain to see
inner work, do not register the inner one.

The asymmetry is worth knowing about precisely because it reads like a bug from the
outside — it is the one place where "which domain owns this path?" and "which sessions
are in this domain?" do not compose. Concretely: `mcx domain which ~/github/mcp-cli`
answers `mcp-cli` by walking **up** to the innermost match, while `mcx claude ls -d
github` compares a stored id and does **not** walk **down**. Both are correct; they are
answering different questions, and only one of them is a partition.

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
- **A rename does not restart the worker, but it is not invisible to it either.** A worker
  is bound to `host` + `path` + `id`; a rename changes none of them, so the process is kept
  and the supervisor's view of it is updated in place (`domainRestartRequired`). The
  worker's *own* copy of the name is not updated — it was handed one snapshot at `init` and
  there is no second control message — so until it next restarts it reports the old name in
  `domain_info`, in its log prefix and in its MCP handshake identity. Nothing keys off any
  of those; the supervisor's map, the partition column and the restart re-resolve are all
  by `id`. This is the running-worker half of the `mcx domain` section's "every `domain_id`
  reference survives a rename", and it was briefly wrong in the other direction: comparing
  the whole row meant a rename silently killed a worker, which once #3044 moves project
  execution here would abort a running phase for a cosmetic edit.
- **Restarts run under `restart-policy.ts`** with the same backoff and crash budget as
  every other worker. A restart re-reads the `domains` row rather than replaying the
  snapshot it started with, and a worker whose row has vanished is *not* restarted.
- **Nothing in a worker survives a restart.** A restart and a move to another host are
  the same event from the worker's point of view, and memory does not move. State that
  must survive belongs in the database.
- **A caller can tell "coming back" from "gone".** `DomainSupervisor.status()` returns a
  discriminated union — `no-such-domain` does not even carry a domain to act on — so the
  retryable and permanent cases cannot be conflated by reading an error string.
- **Partition 0 never gets a worker, and says so.** The unassigned sentinel is not a
  domain, so `ensure(0)` raises `UnknownDomainError` and `status(0)` answers
  `no-such-domain` — an error, never a guess, matching the rule for `-d` above. A worker
  bound to the sentinel would be executing "everything not yet domain-scoped" against one
  path, which is why `validateDomainSnapshot` rejects a non-positive `id` at the worker's
  own boundary too. Nothing in the daemon calls `ensure()` yet; the first caller arrives
  with #3044, and **that** is the change that makes standing outside every domain a
  failure a user can hit — so it needs `mcx domain add` to have landed first.

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
mcx tracked    -d phoenix
mcx claude ls  -d phoenix
mcx monitor    -d phoenix
mcx mail read  -d phoenix
```

### The resolution rule

> A command that acts on domain-partitioned state resolves its domain by walking up from
> `$PWD` to the nearest registered domain. `-d <name>` overrides. **Outside any registered
> domain, `-d` is required and its absence is an error, never a guess.**

Enforced once, in `packages/command/src/domain-guard.ts`, called from `main.ts` before
dispatch — not per command, because the failure it prevents is precisely a surface that
forgot to add its own check. `mcx domain` is exempt: it is how a domain comes to exist.

**The failure mode is the feature.** From outside every domain, a domain-scoped command
exits non-zero, names the registered domains, and writes nothing. It does not fall back to
`process.cwd()`, does not pick the only domain when there happens to be exactly one, and
does not pick the first row. A guess that is right nine times out of ten is worse than an
error, because the tenth writes into another project's tables and nothing reports it —
which is not hypothetical: #3352 and #3353 were both live instances of that class.

`-d <unknown>` errors and lists what *is* registered. `-d _` addresses partition 0 on
purpose (see [Partition 0](#partition-0-is-a-partition-not-a-fallback)).

**One carve-out, for the premise rather than the rule:** on an install with *no* domains
registered at all, default resolution is not enforced. The hazard is landing in the wrong
partition, and that needs a wrong partition to exist — with zero domains there is exactly
one, and every row on the box already lives in it. The rule engages the moment a first
domain is registered, the one-domain case included. An unknown `-d` is an error either way.

Three kinds of command sit behind the rule, and they treat `-d` differently:

| | no `-d`, outside every domain | `-d <other-domain>` | Examples |
|---|---|---|---|
| **named** — acts on daemon-side rows | **error** | redirects the command | `track`, `tracked`, `untrack`, `mail`, `claude ls`, `agent <p> ls` |
| **ambient** — acts on the repository in `$PWD` | **error** | **error**; `cd` there instead | `phase run/show/advance`, `alias` |
| **wide** — already reads every domain | allowed | narrows to that domain | `monitor` |

An ambient command reads *this* checkout's `.mcx.yaml`, lockfile and scripts. Honouring
`-d other` for the partition key while the files came from here would be a half-scoped
write — the same silent mis-scope in the other direction. `-d _` is an error for the same
reason: partition 0 is a partition, not a checkout. `-d` naming the domain the command is
already in is accepted and removed before dispatch, so the flag is safe to pass
unconditionally from a script.

A **wide** command's omitted `-d` is a documented answer rather than a missing one — `mcx
monitor` has always streamed every domain unless narrowed, and refusing it outside a
checkout would break every cron job that watches the box. The rule removes guesses, and
there is no guess here. `-d` is still validated: an unknown name is an error.

`-d` redirects the **whole** command, not only the partition it writes to. `mcx track 42 -d
phoenix --scrutiny high` reads phoenix's `.mcx.yaml` for `initial:` and for the trackable
fields, and writes the phase state under phoenix's root — so a phase script running inside
phoenix reads back what was written. Taking the row's partition from `-d` and everything
else from `$PWD` produced an item in one domain whose metadata lived in another.

> **Upgrading:** if a repo you work in is not yet a registered domain, these commands will
> refuse until it is. `mcx domain add <name> .` from the repo root is the whole migration.
> `mcx domain ls` shows what is already registered — every `~/.mcp-cli/scopes/*.json`
> sidecar was auto-imported as a domain at daemon start.

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
mcx mail -s "..." orchestrator            # local to this domain
mcx mail -s "..." orchestrator@phoenix    # explicit domain
mcx mail -d phoenix -s "..." orchestrator # same thing, said the other way
```

A bare name resolves within the sender's domain. `user@domain` resolves through the
domains table, which is what makes the same syntax work unchanged when `phoenix`
moves to another host.

**The invariant** (#3038), enforced in `packages/daemon/src/mail-domain.ts` rather than
here — this section describes it, that file is what an orchestrator cannot argue with:

> A mail row belongs to exactly one domain partition, and no read, wait, reply or
> mark-read ever observes a row outside the caller's partition. Crossing a partition
> boundary requires an explicit `user@domain` recipient **and** a sender that itself
> has a return address.

### The parse rule

An address splits on the **last** `@`, and a local part may **not** itself contain `@`.

The split rule alone is not enough, and the gap was an exfiltration channel rather than a
cosmetic one. `evil@beta@alpha`, sent from domain `alpha` to a bare local recipient,
splits to local `evil@beta` with `alpha` as the suffix — so a spoof check on the *domain*
passes. It stores as a bare-looking `evil@beta`, and when the recipient replies, that
string re-parses as `evil` at `beta` and carries the body out of `alpha`. Neither party
ever typed `user@domain`.

The real invariant is therefore:

> A stored address must re-parse to the address that was stored.

Forbidding `@` in a local part is the cheapest total way to guarantee it. The split rule
stays exactly as pinned — `a@b@c` still parses deterministically to local `a@b`, domain
`c` — and is then **rejected**. Parsing first and rejecting after keeps the refusal
explicit rather than an accident of where the string happened to divide.

The cost of adopting the syntax is that the trailing segment is *always* read as a domain:
a pre-existing mailbox literally named `claude-a@b` is now `claude-a` at domain `b`, and
errors because `b` is not registered. It fails loudly rather than delivering somewhere
plausible.

### What a bare name means

The caller's own domain, resolved from the **caller's** cwd — never the daemon's, which
is whatever directory `mcpd` happened to start in. `-d <domain>` overrides it.

A cwd outside every registered domain resolves to the **unassigned partition**
(`domain_id = 0`), always — not conditionally. That is a total function, not a guess:
every caller maps to exactly one partition, deterministically, and the answer never
depends on how many other domains happen to exist. What the resolution rule above forbids
is inventing an *arbitrary named* domain for an un-domained caller; partition 0 is the
opposite of arbitrary.

### Partition 0 is a partition, not a fallback

Rows written before any domain was resolved carry `domain_id = 0`. On an existing install
that is the **entire mail history**, so partition 0 is not an edge case to tolerate — it
is where the data is. It therefore has a reserved name, **`_`**, and is a first-class
address:

```bash
mcx mail -d _ -u boss        # read the unassigned partition
mcx mail -s "..." boss@_     # address it from inside a named domain
```

`_` is reserved by construction rather than by a check somebody has to remember: it is
**not a legal domain name** (those must start alphanumeric), so `mcx domain add _ …`
cannot create a domain that shadows it. It also matches the reserved-namespace convention
this codebase already uses for virtual servers — `_mail`, `_work_items`, `_metrics`.

This is deliberately **not** a carve-out conditional on the `domains` table being empty.
An earlier revision made it one, and that was a merge-blocking defect rather than a style
question: the `domains` table is auto-populated at daemon boot by `importScopesAsDomains`
from `~/.mcp-cli/scopes/*.json`, with no user action. On any box that ever ran
`mcx scope`, one domain row appears at startup, a conditional carve-out closes, and every
mail call from outside that one directory starts throwing — orphaning the whole mail
history, including the operator mailbox that sprint workers use to report being blocked.

The general rule that came out of it: **no change may close a partition whose recovery
command has not shipped.** Partition 0 is reachable by name for exactly that reason.

### Cross-domain delivery

`orchestrator@phoenix` is allowed, and it does not become an ambient channel that defeats
the partition, because:

- The row is written into the **recipient's** partition and is readable only there. No
  query anywhere returns rows from more than one partition without the caller naming
  which one — see the `-d` caveat below.
- The stored `sender` is rewritten to `local@sender-domain`, so the reply routes back
  across the boundary instead of hitting a same-named mailbox at home. That stamp holds a
  **name**, so it moves when the domain is renamed and blocks the domain's removal — see
  `mcx domain` above for what `rename` and `rm --force` each do to it (#3247).
- A sender may only qualify itself with its own domain. Otherwise a caller could stamp a
  message as coming from elsewhere and steer the reply into that domain — and because a
  local part cannot contain `@`, that check cannot be bypassed by burying a second
  address in the local half. This is a **typo guard, not an authenticity guard**: it
  stops an accidental cross-domain reply-to, not a deliberate one — any caller can still
  pass `-d beta --from whoever` and have `beta` accept it as a local send.
- An unknown domain in an address errors at **send** time, not as a row nobody reads.

**`-d` is an unauthenticated cross-partition operation, by design.** `resolveCallerDomain`
accepts any registered domain name (or `_`) from any caller in any directory — there is no
notion of "this caller is allowed to act as domain X." That is consistent with the rest of
mcx: every other domain-scoped surface takes `-d` the same way, and partitioning exists to
stop *accidental* cross-domain traffic (the leak this PR was written to close), not to
authenticate callers against each other. So: no query returns rows from more than one
partition *in a single call*, but a caller who names another domain with `-d` reads or
writes there exactly as if they were inside it.

Partition 0 participates on the same terms as any named domain: it can address others and
be addressed, and a reply to a message it sent routes home rather than landing on a
same-named mailbox in the recipient's domain. That falls out of it having a name.

### Failure directions

Every failure fails **closed** — the call throws and nothing is delivered or read. There
is deliberately no branch that widens a query, drops the `domain_id` predicate, or falls
back to a *named* domain the caller did not ask for: mail that degrades to "show
everything" on an unresolved domain is worse than mail that refuses, because the failure
is invisible to both parties. A message id from another domain reads as *not found*,
indistinguishable from a nonexistent one, so probing sequential ids reports nothing about
another domain — and mark-read reports that miss rather than silently succeeding.

`pruneExpiredMail` is the one mail writer that is **not** partitioned, deliberately: it
is the TTL janitor. It moves no bytes across a boundary and exposes nothing; scoping it
would mean a partition whose last caller went away never gets swept. It is reachable from
no IPC method and no CLI command.

### Verifying the guards

Every guard here is checked by **deletion against the concrete-`StateDb` specs**, not
against a hand-written fake. Mutation-testing a guard with a fake proves the fake is
wired to the guard, not that the guard is reachable: an earlier revision had a guard whose
only coverage was a `fakeDb` presenting a combination of states the real database could
not produce, so deleting it left every test green. The rule is: delete the guard, run the
specs that use a real `StateDb`, and if nothing goes red, either the guard is unreachable
or the fake is lying.
