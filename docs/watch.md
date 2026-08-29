# `mcx watch` — a single-stream, filterable site event feed

`mcx watch` gives you one push-based stream of a web app's message events
(Microsoft Teams today), filtered to the threads you care about, as NDJSON.

```
mcx watch <site> <name|id>... [--since <iso|ms>] [--ndjson] [--until <glob>] [--dry-run]
```

```bash
mcx watch teams general devs            # human-readable on a TTY, NDJSON when piped
mcx watch teams general --ndjson        # one JSON line per event
mcx watch teams general --since 2026-08-28T09:00:00Z   # REST backfill, then live
mcx watch teams general --until site.message --max-events 5
mcx watch teams general --dry-run       # validate + plan; no socket, no registrar POST
mcx site threads teams                  # list named threads + post policy
```

Events arrive on the daemon's unified event bus as `site.message` and are
filtered client-side by the requested threads, so `mcx watch` reuses the exact
same stream machinery (`openEventStream` + the `event-filter` glob grammar) as
`mcx monitor`.

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

## Not yet: multi-source join

The `site.message` envelope is deliberately shaped so a future `mcx watch`
could join it with `gh:pr …` / `az:pipeline …` events under one NDJSON stream —
the bus already emits PR/CI events. Tracked as a follow-up.
