# Sensors

A sensor is a scheduled MCP tool call whose results are written to disk. The daemon
does not parse them, diff them, or put them in the message log.

```yaml
sensors:
  gh-issues:
    tool: github/list_issues
    args: { state: open }
    every: 10m
    trust: 2

  teams:
    tool: teams/list_messages
    args: { since: "${cursor}" }
    every: 5m
    trust: 3

  inbox:
    tool: email/fetch
    every: 15m
    trust: 4
```

Any tool on any server — real, virtual, an alias, an AI integration — becomes a
sensor with zero code. This is the whole point: adding a stream should not mean
writing a poller.

## What the event carries

Nothing but pointers and sizes:

```json
{
  "kind": "sensor.ran",
  "domain": "phoenix",
  "sensor": "gh-issues",
  "command": "mcx call github list_issues '{\"state\":\"open\"}'",
  "previous": { "at": "2026-08-21T18:00:04Z", "path": "…/gh-issues/20260821T180004Z.json", "bytes": 48211 },
  "current":  { "at": "2026-08-21T18:10:03Z", "path": "…/gh-issues/20260821T181003Z.json", "bytes": 48755 }
}
```

That is the entire payload. Both run times, the command in re-runnable form, and the
size and path of the old and new snapshot.

The consumer decides what to do. Read one file. Diff the two. Ignore both and re-run
the command itself. Nothing is imposed, and — the reason this shape was chosen —
sensor content never enters the message log, so a chatty stream cannot crowd out
everything else an agent needs to see.

There is deliberately **no identity key, no projection expression, and no diff engine**
in the daemon. Those would each need to be right for every tool anyone ever points a
sensor at, and each would be a place for the daemon to be subtly wrong about data it
does not understand.

## Failure is a value, not an absence

A poll that errors, times out, or returns nothing emits `sensor.degraded` and holds
its cursor:

```json
{ "kind": "sensor.degraded", "sensor": "teams", "error": "browser session dead", "cursor_held": true }
```

This matters more than it looks. A dead browser or an expired token returns an empty
result; a differ would read that as "every item was removed" and cascade. Because the
size is in the event and an error is its own kind, a zero-byte result is visible as a
zero-byte result and never as a deletion.

## Storage and retention

Snapshots live under the domain's state directory, one directory per sensor,
timestamped. Retention is global with a per-sensor override:

```yaml
sensors:
  retention: 30d          # default
  gh-issues:
    retention: 7d
```

```bash
mcx sensor ls        -d phoenix
mcx sensor show      <name>
mcx sensor run       <name>          # once, now, in the foreground
mcx sensor snapshots <name>
mcx sensor gc        [--older-than 30d]
```

## Snapshots are scanned too

`cards.scan` applies to snapshot files, not just cards. Snapshots are the larger and less
reviewed of the two — nobody reads 48KB of GitHub JSON before it lands on disk — so they
are where a secret actually ends up. Scanning them is not a meaningful cost: a sensor on a
10-minute interval writing 48KB is under 100 bytes a second.

## Cursors

A sensor whose tool takes a "since" argument gets `${cursor}` interpolated from the
last **successful** run. Cursors advance only on success, and never on a degraded
poll — which is what makes the machine correct across a laptop sleeping for two days.

## Distribution

Sensors, card kinds, and board renderers all ship through the source URI the phase
manifest already parses:

```yaml
sensors:
  jira:
    source: github:someone/mcx-sensors/jira.ts@v2#sha256=<64hex>
```

Remote sources carry an inline `sha256` pin; there are no unpinned network fetches.
This is the existing mechanism from `docs/phases.md` (currently parsed, install
deferred) rather than a second plugin format.

## Email

Email is two sensors' worth of configuration and no new concepts:

```yaml
sensors:
  inbox:
    tool: email/fetch          # IMAP or POP3
    every: 15m
    trust: 4                   # untrusted, always

egress:
  alerts:
    tool: email/send           # SMTP
    min_trust: 1
```

Inbound mail is ring 4 without exception — it is the one channel where an arbitrary
stranger writes the input. Outbound is an egress action and obeys the domain's egress
policy, which for some domains is `drafts` — write the message, never send it.
