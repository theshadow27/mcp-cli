# Cards

A card is a markdown file with frontmatter. One file per thing: one queue item, one
decision, one piece of feedback.

The property that matters is **durable and readable by a process that did not create
it**. Committed to git is one way to get that and the usual one, but it is not the
requirement — a card store on local disk, gitignored, satisfies it equally.

## Where they live

```yaml
cards:
  dir: .claude/work-items      # no default that implies committing
  scan: block                  # block | redact | warn | off
```

There is no default that quietly puts agent-written text into a git remote. Cards are
the product of unsupervised agentic work, several card kinds *require* verbatim
quoting of source material, and that combination is a leak generator. A project that
wants them committed says so.

Recommended for Claude-Code-driven projects: `.claude/work-items/`. Outside a git repo,
the store falls back to `~/.mcp-cli/cards/<domain>/`.

### Scanning

Card writes go through the daemon, so the daemon is the chokepoint. `cards.scan`
runs a secrets and PII scan **before the file exists**:

- `block` — refuse the write, return what matched and where
- `redact` — write with the match replaced, note the redaction on the card
- `warn` — write, emit `card.scan_warning`
- `off`

Per-kind visibility handles the rest:

```yaml
kinds:
  incident:
    visibility: local     # never written into a committed directory
```

## Kinds

Kinds are declared per domain. `.mcx.yaml`:

```yaml
kinds:
  item:
    dir: items
    statuses: [queued, active, review, blocked, parked, done, dropped]
  decision:
    dir: decisions
    statuses: [open, answered, actioned, dropped]
    pointer_required: [product, instructions]
  feedback:
    dir: feedback
    statuses: [new, acked, actioned, dropped]
```

`pointer_required` is the answer-direction test: for these subjects, an answer that
stays in the card directory is not finished. A decision about product behavior
terminates in a spec, an issue, or a PR; the card records `actioned-as:` pointing at
it, and `mcx card check` **fails** an `actioned` card that lacks one. Without that
gate the card store silently becomes a shadow database of rulings nobody applied.

## Fail-closed rules

Three, ported from the sprint-loop reducer, all of the same shape — an ambiguous card
is never picked up:

1. **Unparseable frontmatter is never runnable.** Every field defaults, so a broken
   `done` card would otherwise present itself as the top of the queue.
2. **An unresolved `blocked-on` id counts as blocking.** Ignoring references we cannot
   resolve turns a typo into silent progress on work that was supposed to wait.
3. **`owner: human` means hands off**, whatever the status says. This is separate from
   status on purpose: an item can be perfectly runnable, unblocked, and mid-review and
   simply not be the loop's to take. Without the field, the only way to hold an item
   was to lie about its status, and the lie propagated into the tally and the tick.

## Staleness

Every card carries `last_checked`, `last_shown`, and a hash of what was last displayed.
A card may appear in a briefing only if it has never been shown, or if it was
re-verified this cycle and something actually changed.

A re-check that finds nothing new updates `last_checked` and the card stays out.
Un-rechecked cards never re-display. This is the most expensive lesson in the four
generations that preceded this design: restating a stale status is how work moves
underneath the person reading the board, and a board that does it is worse than no
board.

## Trust

Cards carry the ring of their least-trusted input, propagated from the sensor that
produced them. See [trust.md](trust.md).

## Commands

```bash
mcx card ls    -d phoenix [--kind item] [--status open] [--json]
mcx card show  <id>
mcx card new   <kind> [--title "..."]
mcx card set   <id> <key> <value>
mcx card check -d phoenix     # lint: parse, dangling refs, pointer-required, order/filename
mcx card scan  -d phoenix     # secrets + PII sweep over the existing store
```

`mcx card check` is meant to join the project's own gate, the way `bun sprint check`
joins `am-i-done` — state that lies should fail the build.

Verbs stay **generic**. `mcx card ls --kind item` rather than `mcx item ls`: kinds are
domain-declared and open-ended, so a per-kind verb would mean a command surface that
changes shape per directory, and shell completion that cannot be static.

## The `_cards` virtual server

Cards are also exposed as MCP tools by a virtual server, alongside `_work_items`,
`_metrics`, and `_spans`:

```
_cards/card_list      _cards/card_get      _cards/card_new
_cards/card_set       _cards/card_check
```

This is how an agent reads and writes them without shelling out, and it is where the
readable naming lands — a tool description can say "queue items and decisions for this
domain" while the CLI stays one verb. Scoped by `domain_id` like every other virtual
server, so a session in one domain cannot enumerate another's cards.

## Storage

The files are the record. SQLite holds an index for querying, and the index is
rebuildable from the directory at any time. If the index were authoritative you would
lose review, attribution, and the ability for a successor process to reconstruct the
world by reading a directory instead of inheriting 300k tokens of context.

Writes edit the one frontmatter line they were asked to edit. A parse-and-restringify
round trip would reflow every hand-written card and bury real changes in whitespace —
these files are hand-edited by people as often as they are written by tools.
