# `mcx watch` — one filterable stream: site messages joined with GitHub PR/CI

`mcx watch` gives you one push-based stream, as NDJSON, that interleaves a web
app's message events (Microsoft Teams today) with a GitHub PR's `pr.*` /
`checks.*` / `ci.*` events — one envelope, one cursor, so a consumer sees "PR
state + CI + Teams chatter for one work item" without running N watchers.

```
mcx watch <source>... [--since <iso|ms>] [--ndjson] [--until <glob>] [--dry-run]
```

A `<source>` is one of:

- **a site source**: a `<site>` followed by its `<name|id>...` threads
  (`teams general devs`). The first non-`gh:` positional is the site; the rest
  are its thread names/ids.
- **a PR source**: `gh:pr#<n>` (the `gh:pr:<n>` spelling is also accepted) →
  watch PR #`<n>`'s `pr.*` / `checks.*` / `ci.*` events.

```bash
mcx watch teams general devs            # site-only: human on a TTY, NDJSON when piped
mcx watch teams general --ndjson        # one JSON line per event
mcx watch teams general gh:pr#123       # interleave a thread's messages with PR #123's events
mcx watch gh:pr#123 gh:pr#124           # PR-only: no Trouter watcher is started
mcx watch teams general --since 2026-08-28T09:00:00Z   # REST backfill (site only), then live
mcx watch gh:pr#123 --until ci.finished --max-events 5
mcx watch teams general --dry-run       # validate + plan; no socket, no registrar POST
mcx site threads teams                  # list named threads + post policy
```

`mcx watch teams general` and `mcx watch teams general devs --ndjson` behave
exactly as before — the source grammar is purely additive.

## The source-token join

Events arrive on the daemon's unified event bus already in the flat
`MonitorEvent` envelope: `site.message` from the `_site` worker, and `pr.*` /
`checks.*` / `ci.*` from the work-item poller. `mcx watch` is a pure consumer of
both — it starts no producer.

**One envelope, one stream.** Every event — Teams message or PR/CI — is the same
`MonitorEvent` and is printed through the same path (human one-liner on a TTY,
NDJSON otherwise). Site events keep their `threadName` enrichment; PR/CI events
render through their existing `formatMonitorEvent` formatters.

**The OR union.** The server-side stream filter is AND-combined and cannot
express "(`site.message` on these threads) OR (PR events for #123)". So `mcx
watch` subscribes broadly — a `type` glob union over `site.message` +
`pr.*,checks.*,ci.*` for exactly the source kinds present — and then applies a
**client-side predicate that passes an event matching ANY source**: one matcher
per source (the site source keeps the thread-set filter; each PR source is a
`createEventMatcher({ type: [pr.*,checks.*,ci.*], pr: n })`), OR-combined. This
reuses the same `event-filter` matcher machinery as `mcx monitor`.

## The tracked-PR precondition

**`gh:pr#N` only yields events while PR #N is tracked.** The work-item poller
polls only tracked items (`work-item-poller.ts` filters `prNumber !== null`), so
an untracked PR produces no `pr.*` / `checks.*` / `ci.*` events at all. On
startup `mcx watch` checks each requested PR against the tracked set (the same
`listWorkItems` query `mcx tracked` uses) and prints a warning to stderr for any
that is not:

```
warning: PR #123 is not tracked; no PR events will stream until 'mcx track 123' is run
```

`mcx watch` **never auto-tracks.** `mcx track <prNumber>` / `mcx untrack
<prNumber>` have an asymmetric-resolution hazard (#3240) — tracking a PR number
can create a junk duplicate, and untrack-by-PR can delete a real work item — so
watch only warns and leaves tracking to you.

## Terminators and `--since`

`--until <glob>`, `--max-events <n>`, `--timeout <secs>`, and `--dry-run` work
across all source kinds. `--dry-run` reports the resolved plan — the site watcher
plan (when a site source is present) and each PR source with its tracked/untracked
status — without opening the live socket, starting the Trouter watcher, or
hitting the network.

**`--since` backfill applies to site sources only.** PR sources have no backfill
path (the poller has no resumable REST offset for arbitrary history). A `--since`
on a PR-only watch is not an error — it prints a one-line note and proceeds
straight to the live stream.

`az:pipeline` sources are **not yet supported** — they need an Azure Pipelines
event producer on the bus first, tracked separately.

## Architecture

```
Teams chatsvc ──push──▶ Trouter WebSocket (socket.io 0.9)
                              │  (held by the _site daemon worker)
                              ▼
                    TrouterWatcher  ──normalise──▶  site.message on the event bus
                       │      │                          │
                   cursor    gap-fill                 openEventStream
                  (mcx.db)  (get_messages)               │
                                                    mcx watch (client-side thread filter) ──▶ NDJSON
```

- **`packages/daemon/src/site/trouter-codec.ts`** — hand-rolled socket.io-0.9
  frame codec (`type:id:endpoint:data`). Trouter speaks legacy 0.9, not modern
  socket.io/Engine.IO v4, so no client library fits.
- **`packages/daemon/src/site/trouter-normalize.ts`** — turns a raw Teams event
  body (or a `get_messages` REST row) into a flat `NormalisedSiteMessage`.
- **`packages/daemon/src/site/trouter-worker.ts`** — `TrouterWatcher`, the pure
  state machine. Every side effect (WebSocket, registrar HTTP, credential
  lookup, event-bus publish, cursor store, REST gap-fill) is injected, so it is
  unit-tested against synthetic frames with zero network.
- **`packages/daemon/src/site/trouter-live.ts`** — the live adapter that wires
  the watcher to Bun's `WebSocket`, `proxyCall` + the site's credential vault,
  the `publishEvent` IPC, the `siteWatchCursor{Get,Set}` IPC, and the
  `get_messages` backfill. This is the only network-touching layer, and it lives
  in the `_site` worker so the ic3 bearer never leaves the vault-owning process.
- **`packages/command/src/commands/watch.ts`** — the CLI.

The watcher runs inside the `_site` worker (co-located with the credential
vault). It publishes normalised events to the daemon bus via the sanctioned
`publishEvent` IPC (the same path the vfs producer uses) and persists its
per-thread cursor to mcx.db via two narrow IPC methods.

## Envelope schema (`site.message`)

Flat fields, spread at the top level of the monitor-event envelope (never nested
under `payload`):

| field | meaning |
|---|---|
| `site` | site name, e.g. `teams` |
| `thread` | thread id (mri/conversation id) |
| `threadName` | configured name from threads.yaml when known (else the wire topic) |
| `id` | stable message id (epoch-ms string), unchanged across edit/delete |
| `version` | mutation clock (epoch-ms string); `version > id` after edit/delete/reaction |
| `at` | ISO timestamp (composetime) |
| `from` | sender display name |
| `from_id` | sender MRI (`8:orgid:<oid>`) |
| `is_me` | true when the sender is us |
| `mentions_me` | true when the message @-mentions us |
| `kind` | `new` \| `edited` \| `deleted` \| `reaction` \| `thread` |
| `text` | plain-text rendering (HTML + quoted-reply blockquote stripped) |
| `reply_to` | quoted-reply target message id, when a reply |

Kind discrimination: `deletetime` present → `deleted`; `edittime` present →
`edited`; a `MessageUpdate` with `version != id` and neither → `reaction`;
`ThreadUpdate` / `ConversationUpdate` / `ThreadActivity/*` → `thread`; otherwise
`new`. Severity: a message that mentions you is `actionable`; your own messages
are `info`; the rest is `notable`.

## Named threads + post policy (`threads.yaml`)

`~/.mcp-cli/sites/<site>/threads.yaml` (a `.json` file of the same shape is
accepted; `.yaml` wins if both exist):

```yaml
general:
  id: "19:...@thread.v2"
  post: deny            # "allow" (default) | "deny"
  notes: "read-only broadcast channel"
  watch: true           # auto-start the watcher for this site at daemon boot
devs:
  id: "19:...@thread.v2"
  post: allow
```

- **Name resolution.** A name used anywhere a `threadId` is accepted (any of
  `threadId`, `conversationId`, `chatId`) resolves to its id, and output records
  carry the configured name in `threadName`.
- **Post policy.** `post: "deny"` is enforced at the site tool layer
  (`handleCall`, after the request is resolved): a write
  (`POST`/`PUT`/`PATCH`/`DELETE`) whose resolved thread id is a denied thread is
  refused with a clear error — **passing the raw id instead of the name cannot
  bypass it**, because the deny lookup is by resolved id.

`mcx site threads <site>` lists name / id / policy / notes / watch.

## Gap-fill and the cursor

The Trouter stream is a live tail, not a durable log — there is no resumable
offset. On (re)connect the watcher backfills each watched thread with a bounded
REST `get_messages --startTime <lastVersion+1>` call and republishes anything
missed. The per-thread high-water `version` is persisted in mcx.db
(`site_watch_cursor`), and events are de-duplicated by `id:version` so a backfill
that overlaps the live tail prints each change once.

`--since` runs the same backfill from a caller-supplied time (ISO or epoch-ms)
before switching to live.

## Lifecycle

The watcher starts **lazily on first `mcx watch`** (the CLI calls
`site_watch_start`, which ensures the socket is up and adds the requested threads
to the gap-fill set). It **also** auto-starts at daemon boot for any site whose
`threads.yaml` has `watch: true` entries. `mcx watch --dry-run` resolves and
validates configuration and prints the plan without opening a socket or POSTing
the registrar.

## The verified handshake (built to this, exactly)

Trouter is socket.io 0.9 framing (`N:::` / `N:id+::` prefixed strings), not
modern socket.io — the codec is hand-rolled. The sequence below was validated
live end-to-end out-of-band; the build here targets it and the unit tests drive
it with synthetic frames.

1. Connect `wss://<pool>-t.trouter.teams.microsoft.com/v4/c?tc=…&timeout=40&epid=<OUR fresh GUID>&ccid=&cor_id=<GUID>&con_num=<epochms>_0&v=v4&auth=true`.
2. On RX `1::` → **immediately** TX `5:::{"name":"user.authenticate","args":[{"headers":{Authorization:"Bearer <ic3>","X-MS-Migration":"True","X-Ms-Test-User":"False"},"connectparams":null}]}`. `connectparams` is `null` on a cold connect; do **not** wait for `trouter.connected` to authenticate.
3. RX `5:1::{"name":"trouter.connected","args":[{surl,…}]}` → capture `surl`.
4. RX `5:N::{"name":"trouter.message_loss",…}` → ACK `5:M::{"name":"trouter.processed_message_loss","args":<echo>}`.
5. POST `https://teams.cloud.microsoft/registrar/prod/V2/registrations` (aud ic3) with `templateKey:"TeamsCDLWebWorker_2.6"`, our own fresh `registrationId`, and `transports.TROUTER[0].path = <surl>` → expect 202.
6. Events arrive as `3:::{"id":n,"method":"POST","url":"/v4/f/<flow>/messaging","body":"<json string>"}` → parse body, ACK `3:::{"id":n,"status":200,"headers":{},"body":""}`.
7. Heartbeat: reply `2::` to `2::`; app ping `5:N+::{"name":"ping"}` → `6:::N+["pong"]`.
8. Shutdown: `DELETE .../registrations/<registrationId>` → 202.

### Hazards

- **Always our own fresh `epid` + `registrationId`.** Never reuse a human tab's,
  and never send anything that purges another endpoint's subscriptions — two
  endpoints per user is normal (chatsvc fans out to web + mobile + desktop).
- **The pool is dynamic** and changes on refresh. The authoritative `surl` to
  register always comes from the `trouter.connected` frame — never hardcode it.
  The initial `-t` host to dial is read from `MCX_TEAMS_TROUTER_HOST` for the
  live check.
- **The ic3 credential never leaves the vault-owning `_site` worker.** The
  registrar POST/DELETE and the WS auth frame are both built there.

### Running the one live check

The build performs **no** live Trouter/registrar/WebSocket calls; that path is
validated out of band. To run the single manual smoke check, a human sets
`MCX_TEAMS_TROUTER_HOST` to a current `<pool>-t.trouter.teams.microsoft.com` host
and runs `mcx watch teams <thread>` (without `--dry-run`) against a live,
authenticated Teams session.

## Multi-source join: status

The `gh:pr#<n>` join is implemented (see "The source-token join" above). The
`az:pipeline …` half is **not yet** wired — it needs an Azure Pipelines event
producer on the bus first, and is tracked separately.
