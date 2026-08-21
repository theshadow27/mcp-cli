# Epic: domain-scoped mcx — the agentic loop harness

## Why

The same system has now been built four times:

| Gen | Where | Human surface | What it monitors |
|---|---|---|---|
| 1 | `clrg-stats` — `wip/roadmap/` + `tools/loop/` + `packages/roadmap` | `bun roadmap serve` (decide-ui2) | its corpus + GitHub |
| 2 | `work` — `loop/` | Bun app on :4711, ~1.7k lines | Teams, Outlook, Jira, Confluence, GitHub |
| 3 | `phoenix-octovalve` — `.mcx.yaml` + `.claude/phases/` | GitHub Projects | GitHub |
| 4 | `phoenix-octovalve@feat/sprint-loop` — `scripts/sprint/` | `bun sprint serve` on :7788, ~2.5k lines | GitHub |

These are not independent designs — 2 was copied from 1, 3 and 4 from 2. That makes the
useful signal **what survived four copies** versus what was rewritten every time.

**Survived every generation** (load-bearing; nobody who inherited it dropped it):
- a file per card, frontmatter plus markdown body, durable outside any process
- `decisions/inbox/` → `answered/`, the human's write being the attribution
- a state file with a "known-good" predicate, and a tick that asks whether it is still true
- personas with a defined end: satisfied → handoff → exit
- a watchdog that reports and alerts but never removes

**Rewritten every generation** (therefore configuration, never harness):
- what the sensors are, the egress policy, the subject vocabulary, the card kinds,
  the risk lanes, and the entire human surface — rewritten from scratch three times

**Appeared only in generation 4**, and is the reason this epic exists at all:

> `nextAction()` in `scripts/sprint/select.ts` — *"The point of putting this in a function
> rather than a paragraph of a skill file is that 'urgent feedback comes first' stops being
> something an orchestrator can rationalize its way around at 2am with 300k tokens of
> context pressure."*

That is the fix for orchestrator degradation. Not better instructions — moving the
invariant out of the instructions and into a function the harness calls. It generalizes
into a rule this epic adopts throughout: **any invariant an orchestrator could rationalize
past is a function, not prose.**

Meanwhile all four share three gaps none of them closed: no cost or quota management, no
multi-project isolation, and no authentication on any of the web surfaces.

## Architecture

```
agents ──> mcx (bash) ──> daemon ──┬──> domain server (phoenix) ──> project code
                                   ├──> domain server (clrg)    ──> project code
                                   └──> domain server (work)    ──> project code
```

Project code never runs in the main daemon. Each domain gets a worker, addressed by
`onmessage`/`sendMessage`, which becomes a websocket port when a domain moves to another
host — the control protocol is the same either way.

Three orthogonal command families, deliberately not merged:

| Family | Owns | Question |
|---|---|---|
| `mcx domain` | names → `[host:]path` | where does `phoenix` live? |
| `mcx loop -d <domain>` | executor, timer, reducer | is work being picked up? |
| `mcx machine` *(deferred)* | host and hardware lifecycle | is the box up? |

`mcx machine` is **out of scope** — it is multi-node's entry point and should be designed
with multi-node, not ahead of it. Noted so the seam stays open.

Domains stay pure data — routing and partitioning, the DNS table. No status column.
A domain can resolve while its machine is down; a machine can be up while its loop is off.

Docs: [`domains.md`](domains.md) · [`cards.md`](cards.md) · [`sensors.md`](sensors.md) · [`trust.md`](trust.md) · [`console.md`](console.md)

## The epics

| | Epic | Depends on |
|---|---|---|
| **A** | Domains + clean-slate DB | — |
| **B** | Domain servers | A |
| **C** | Trust rings + console auth | A, B |
| **D** | Cards | A, C |
| **E** | Reducer + scheduler | B, D |
| **F** | Sensors + snapshot store | B, C |
| **G** | Email transport | C, F |
| **H** | Console (`mcpctl` on the web) | C, D |
| **I** | Spend + quota per domain | A |
| **J** | Dogfood + bootstrap | E, H |

---

### A — Domains + clean-slate DB

**Major version bump: domain-scoped mcx. New DB file, new name. Not a migration.**

- `domains` table: `id`, `name`, `host`, `path`, `created_at`. No state column.
- `domain_id` FK on `work_items`, `mail`, `agent_sessions`, `alias_state`, events, automation.
- `mcx domain add | ls | show | which | rename | rm`
- **Supersedes `mcx scope`** (`packages/command/src/commands/scope.ts`) — already a
  name→root registry in JSON sidecars, already threaded into the daemon as `scopeRoot`
  for session filtering. Same idea, promoted to the table and given a host component.
- Mail addressing becomes `user` (local to domain) and `user@domain` (resolved through
  the table) — the syntax that survives the move to another host unchanged.
- **Import**: if the old DB exists and carries no import marker, best-effort one-shot,
  stamp it, never re-run. No rollback path, no dual-write, no "swap in progress", and
  **no tests around roll-forward or rollback**. Single-user local tool, installed once.

Closes the isolation gaps found in the audit: `work_items` has no repo column and globally
unique `issue_number`/`branch`/`pr_number`; `mail` has no scoping at all; the
`AutomationDispatcher` is constructed once from `process.cwd()` at daemon start
(`packages/daemon/src/index.ts:762`). `alias_state`'s `(repo_root, namespace, key)` is the
precedent being generalized.

### B — Domain servers

- One worker per domain; phases, automation, sensors, the reducer and renderers run there.
- Two worker kinds that do not overlap: a **domain worker** per domain running project
  code (phases, automation, sensors, reducer) and serving no HTTP; and **one board worker**
  serving the console for all domains. They fail differently and neither should take the
  other down.
- Reuses `abstract-worker-server.ts`, `worker-control-message.ts`, `worker-transport.ts`,
  `restart-policy.ts`; the `site-worker` supervision pattern is exactly this shape.
- **Blast radius**: a domain crash restarts one domain. The daemon, which owns spawning,
  stays up.

### C — Trust: authority, envelopes, and console auth

Foundational, not a hardening pass — provenance cannot be retrofitted.

**The property**: a more privileged context never receives content whose chain does not end
in a `permit` at that authority or above. Not summarized, not quoted, not "for situational
awareness". An instruction not to follow imperative text is a request, and requests degrade;
not passing the bytes is not a request.

**Containment is reflexive, not attested.** The model verifies nothing. It receives the
content or a stub, and the difference is made before the request is built — no envelope in
context, no chain to read, no authority header to reason about, zero tokens spent. Metadata
a model must notice is metadata a model can fail to notice. All envelope machinery is
host-side; the chain exists for the operator and the audit log.

- **Envelope chain.** Each classifier pass appends a disposition — `permit | deny | flag` —
  wrapping the content, its authority, and every prior disposition.
- **No cryptographic signing.** On one box the daemon is sole reader and writer, so a
  signature defends against nothing that isn't already game over. It becomes real when
  envelopes cross hosts — a multi-node concern, solved at the domain boundary, a layer
  below this.
- **`flag` is the load-bearing verdict.** A human converts it to permit or deny, and that
  conversion is itself a signed disposition at `operator` authority. This is the difference
  between a classifier that must be right and one that need only be decisive about what it
  is unsure of.
- **Default classifier ships with mcx**, taking an **authority input** — always *"may this
  be permitted at authority N"*, never *"is this safe"*. The same paragraph is a fine ring-3
  note and an unacceptable ring-1 instruction.
- Ring 0 operator · 1 authenticated console · 2 private GH and own CI · 3 Teams/Jira/
  Confluence · 4 email, public GH, web. Declared per sensor; GH derivable from repo
  visibility.
- Actions declare `min_authority`.
- **The operator sees all message flow** — permitted, denied, and awaiting review — and can
  open any of it, denied included. Denial hides content from models, never from the person
  responsible for the system.
- **Deny rate is a metric, not a column.** A steady stream of denies means either somebody
  is probing or the classifier has drifted and is eating legitimate traffic. Neither is
  visible per-card; you only see it in the rate. `trust.permitted` / `trust.flagged` /
  `trust.denied` counters per sensor and per domain, plus a `trust.deny_rate_threshold`
  event. The operator disambiguates the two causes — which is why they can read denied
  content.

**Prior art, confirmed in the `claude` binary v2.1.239** — worth reading before building
this, and captured in `trust.md`:
- `authority` is already a first-class provenance field: `human-principal` renders with a
  visible verified marker, `peer-agent` is marked as not-the-user, and `world-event` is
  **dropped entirely** from the classifier transcript.
- Untrusted content is tag-wrapped with **nested wrapper tags neutered** (`<transcript …>`
  inside the payload becomes `[transcript …`) so it cannot close its own container, plus
  `\uXXXX` escaping.
- Rule categories map exactly onto our verdicts: `allow` → permit, `soft_deny`
  ("block unless clear user intent authorizes") → flag, `hard_deny` ("user intent does not
  clear these") → deny, plus `environment` for setup context.
- **Rules themselves carry provenance** — `tengu_settings_auto_mode_rules_untrusted_source_ignored`;
  a repo's own PR template is `untrusted_repo_pr_template`. Easy step to skip.
- Two-stage (`CLAUDE_CODE_TWO_STAGE_CLASSIFIER`) with tight output contracts
  (`<block>yes|no</block>`, `<severity>N</severity>` + `<category>`), strict "nothing before
  the tag" discipline, and a standing "err on the side of blocking".
- It dumps its own prompts on classifier error to `auto-mode-classifier-error.txt` in three
  sections — inducing that error in auto mode yields the verbatim prompt if we want it.

### D — Cards

- Kinds declared per domain; `cards.dir` configurable with **no default that implies
  committing**; recommend `.claude/work-items/`.
- `cards.scan: block | redact | warn | off` at write time; `visibility: local | shared`.
- Fail-closed: unparseable frontmatter is never runnable; unresolved `blocked-on` blocks;
  `owner: human` means hands off whatever the status says.
- Staleness triple `last_checked` / `last_shown` / content hash, with the never-redisplay
  rule.
- `pointer_required` subjects — `mcx card check` fails an `actioned` card with no
  `actioned-as:`.
- Files are the record; SQLite is a rebuildable index.
- Verbs stay **generic** (`mcx card ls --kind item`), with a `_cards` virtual MCP server
  alongside `_work_items` / `_metrics` / `_spans` for agent access. Per-kind verbs would
  mean a command surface that changes shape per directory and completion that cannot be
  static; the virtual server is where readable per-kind naming lands.

**Port**, don't rewrite: `scripts/sprint/{model,select,store,check}.ts` from
`phoenix-octovalve@feat/sprint-loop` are pure, specced, and already reviewed once.

### E — Reducer + scheduler

- `nextAction` is a domain-supplied function executing in the domain server.
- `mcx loop next` and `mcx loop why` — the latter required, since a bad reducer otherwise
  stalls the loop silently.
- `next_check` on cards → `card.due`; one timer wheel over `min(next_check)`.
- Singleflight, debounce-stamp written **before** the spawn, success judged by liveness
  probe and never by exit status.
- `mcx loop on | off | pause` — three states; enforced at the daemon's spawn point.
- `mcx loop install` — **one** OS unit supervising `mcpd`, not a cron entry per domain.
  Sleep-aware (`Persistent=true` / `StartCalendarInterval`); sweeps run from durable
  cursors. Deletes both existing `tick.sh` files, whose three stated reasons to exist
  (a lock, a PATH, a root) the daemon supplies intrinsically.

### F — Sensors + snapshot store

- Declarative `[tool + args + every]`. Any MCP tool — real, virtual, alias, AI
  integration — becomes a sensor with no code.
- Results are written to files. **The daemon does not diff, parse, or key them**, and
  content never enters the message log. The event carries: both run times, the command in
  re-runnable form, and old/new path and size in bytes. The consumer reads, diffs, or
  re-runs as it prefers.
- Errors and empty results emit `sensor.degraded` and hold the cursor — a dead browser
  must never read as "everything was deleted".
- Retention global, default 30d, per-sensor override.
- Finish the already-parsed `github:…#sha256=` / `https://…#sha256=` pinned install path
  from `docs/phases.md` so sensors, kinds and renderers ship as plugins rather than
  inventing a second format.

### G — Email transport

- Inbound IMAP/POP3 → cards, **ring 4 without exception** — the one channel an arbitrary
  stranger writes.
- Outbound SMTP for alerts, subject to the domain's egress policy, which for at least one
  target domain is `drafts` — write it, never send it.
- Both off by default; no new concepts beyond a sensor and an egress action.

### H — Console (`mcpctl` on the web)

Not a sprint UI and not a per-domain board — the same daemon-visibility surface `mcpctl`
already is, rendered in a browser, authenticated, on for as long as it is on.

- **One read model, two renderers.** `mcpctl` today has `servers | logs | agents | stats |
  plans | mail | registry` plus a scope selector. The scope selector becomes the **domain**
  selector, and two tabs are added — **cards** and **flow** — *in both front-ends*, off the
  same IPC methods. Anything the web can show, the TUI shows. The temptation is to let the
  web version grow richer because HTML is easier; the cost lands the first time someone
  diagnoses something over SSH.
- End state is full daemon visibility on the web. Start is cards and flow, because those
  are the two things with no surface at all today.
- **One console for all domains.** `-d` filters a view; it does not start a second server.
  An offline domain still has cards and they are still readable.
- **Its own worker.** Domain workers run project code and serve no HTTP; the console worker
  serves HTTP and runs no project code. Neither can take down the other, and neither can
  take down the daemon, which owns spawning.
- **The page is built at install.** `Bun.build` over the console plus any project-supplied
  renderers — typechecks them at `mcx install` rather than in a browser, emits one bundle,
  and fails the install on a type error instead of serving a broken page.
- **Authenticated only.** One-time code in the URL, exchanged for a session cookie and
  invalidated. `mcx console serve` refuses to bind without an auth mode. No unauthenticated
  HTTP surface ships — not on localhost, not behind a tailnet, and the console shows
  strictly more than any prior generation's page did.
- Binds `0.0.0.0` by default, `--host`/`--port` flags and `console.{host,port,enabled}`
  config like everything else. `0.0.0.0` is only reasonable *because* auth is mandatory —
  which is why C lands before H.
- **`console` is the process; `dashboard` is its landing tab** — the across-domains
  overview the ported sprint board becomes. The surface takes actions (approve, answer,
  clear), and a dashboard that mutates state is misnamed.
- **No privileged path.** Every `/api/*` route wraps an IPC method the CLI can call too.
  Keeps multi-node open; makes the console testable without a browser.
- Default renderer using the vocabulary both prior UIs landed on; `renderer:` per card
  **kind** via the pinned source URI.
- Rows keyed and patched individually so typed text, caret, scroll and `<details>` state
  survive a poll — a bug generation 4 already hit and fixed.
- The cards tab is where a plan is approved, a decision answered, and a flagged envelope
  cleared: one click plus a reason, each landing as an event.
- **Denied content renders as escaped plaintext only** — never markdown, never HTML. A
  denied payload is by definition the thing that tried something; rendering it hands it a
  second attempt against a browser instead of a model.

### I — Spend + quota per domain

- Rollup from `agent_sessions` — `repo_root`, `total_cost`, `total_tokens` already exist.
- Transcript scrape for sessions the daemon did not spawn, deduped by `message.id`.
- `budget:` per domain, enforced at spawn.
- Every figure names which of the two sources it came from.

Generation 1 already built this a third time (`bun roadmap burndown`), which is the
argument for it living here.

### J — Dogfood + bootstrap

mcp-cli is domain #1, and the target is a sprint boundary that costs exactly one click.

Today: a human kicks off `plan`, a human kicks off `run`, then retro / review / rebuild
are automatic. Closing the loop is not removing the human — it is collapsing two kickoffs
into one review of a plan the planner already wrote:

```
sprint.completed ──> planner phase (bounded, budget-capped, exits)
                       └──> plan card: one checkbox per issue, DEFAULT CHECKED,
                            plus a comment field
                              └──> [Approve] ──> run
```

The human unchecks what they do not want, adds notes, approves. That is the whole
interaction.

Then: `bootstrap-loop` skill with presets per repo economics — ledger (no CI, no artifact),
product (CI, commits cost money), corpus (accuracy over spend) — written out explicitly
rather than hidden behind a profile enum. Migration order: phoenix, then clrg, then work.

## Non-goals

- Not a project-management tool. The board answers one question: what is the loop waiting
  on, and what is the cheapest click to unblock it. Backlog grooming stays in GitHub.
- Not a card database. Cards are files.
- The daemon does not transpile project TSX at request time — it is built at install.
- `mcx machine` / hardware lifecycle. Deferred to multi-node.
- No rollback story for the DB. One-way, one-time.

## Settled

- Trust rings follow the conventional direction: ring 0 most privileged.
- Port `scripts/sprint/` rather than clean-rooming it.
- Domain servers are workers now; `onmessage`/`sendMessage` becomes a websocket port later.
- Domains stay stateless. Machine control is deferred; loop control is its own family.
- `mcx domain` supersedes `mcx scope`.
- Card verbs generic + a `_cards` virtual server.
- The console is `mcpctl` on the web — one server, all domains, its own worker, page
  `Bun.build`-ed at install. Cards and flow land in the TUI too, off the same read model.
- Dispositions are unsigned for now; signing is a multi-node concern one layer down.
- Containment is reflexive: the model verifies nothing and spends no tokens on it.
- The operator sees denied content, rendered as escaped plaintext only; deny rate is a
  metric with a threshold event.
- Console binds `0.0.0.0` by default, flag + config overridable.
- `console` is the process, `dashboard` is its landing tab.
- Snapshots are scanned like cards — ~100 bytes/sec, no meaningful cost.
- Trust is an envelope chain with permit/deny/flag and a signed disposition per pass;
  the default classifier takes an authority input.

## Open

None blocking. Everything above is settled; open questions will come out of building it.

