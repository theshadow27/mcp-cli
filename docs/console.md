# The console

`mcpctl` on the web. Not a sprint UI, not a board — the same daemon-visibility surface the
TUI already is, rendered in a browser, authenticated.

```bash
mcx console serve [--host H] [--port P]   # on for as long as it is on; serves everything
mcx console browser                       # open it, authenticated
mcx console url                           # print an authenticated URL
```

Binds `0.0.0.0` by default, overridable by flag or config like everything else:

```json
{ "console": { "host": "0.0.0.0", "port": 7788, "enabled": true } }
```

`0.0.0.0` is only a reasonable default *because* authentication is mandatory — which is
the whole reason trust lands before the console rather than after it. On a tailnet box
this is what you already want; on anything else the auth gate is what stands between the
page and the network.

## One read model, two renderers

`mcpctl` today has tabs for `servers | logs | agents | stats | plans | mail | registry`
and a scope selector. Under this epic the scope selector becomes the **domain** selector,
and two tabs are added — **cards** and **flow** — in *both* front-ends.

That is the rule worth holding: anything the web console can show, `mcpctl` shows too, off
the same IPC methods. Two renderers over one read model, never two read models. The
temptation is to let the web version grow richer because HTML is easier, and the cost shows
up the first time someone diagnoses something over SSH.

The end state is full daemon visibility on the web. The start is cards and flow, because
those are the two things that currently have no surface at all.

## Not per-domain

One console, always on when enabled, showing every registered domain. `-d` filters a view;
it does not start a different server. A domain that is offline still has cards, and they
are still readable.

## It runs in its own worker

Not in a domain worker. Domain workers run project code and serve no HTTP; the console
worker serves HTTP and runs no project code. They fail differently and neither should take
the other down — and neither should be able to take down the daemon, which owns spawning.

## The page is built at install

A project must be installed before it runs, the same as phases today. Install runs
`Bun.build` over the console page plus any renderers the project supplies, which:

- typechecks every project-supplied renderer, at `mcx install`, not in a browser
- emits one bundle, so nothing is transpiled at request time
- fails the install on a type error, rather than serving a broken page

## Authentication

`mcx console browser` opens a URL carrying a one-time code, exchanged for a session cookie
and immediately invalidated. `mcx console serve` refuses to bind without an auth mode
configured.

**No unauthenticated HTTP surface ships** — not on localhost, not behind a tailnet. Every
prior generation of this system serves plain HTTP with no auth today, and the console shows
strictly more than any of them did.

## No privileged path

Every `/api/*` route is a thin wrapper over an IPC method that `mcx` can also call from the
command line. There is nothing the page can do that the CLI cannot, which is what keeps
multi-node open and what makes the console testable without a browser.

## Views

| Tab | Shows | Also in `mcpctl` |
|---|---|---|
| **dashboard** | the landing view — where everything is at, across domains | yes |
| **cards** | queue, decisions, feedback, per domain | yes |
| **flow** | every message and its disposition; deny rate | yes |
| servers, logs, agents, stats, plans, mail, registry | what `mcpctl` shows today | already there |

The cards tab is where a plan gets approved, a decision gets answered, and a flagged
envelope gets cleared — one click plus a reason, each landing as an event.

**Denied content renders as escaped plaintext only** — never markdown, never HTML. Links
are not links, scripts are text, images do not load. See [`trust.md`](trust.md).

## Naming

`console` is the process — the thing that is on or off, that you authenticate to, that
serves. **`dashboard` is its landing tab**: the across-domains overview that the ported
sprint board becomes.

Two words for two things rather than two words for one. The distinction that decides it is
that the surface takes *actions* — approve a plan, answer a decision, clear a flag — and a
dashboard that mutates state is misnamed. `mcx console browser` opens the dashboard;
`mcpctl` gets the same tab, in the same position.
