# Sprint 78 shutdown state — #3037 (work_items domain scoping)

- **Who**: implementer for issue **#3037**, epic A (#3021) of arc #3019
- **PR**: #3175
- **Branch**: `feat/issue-3037-work-items-domain`
- **Head SHA**: `f9c5835a06681dd13f4dd20d620cb257758fc57f`
- **Worktree**: `/home/ubuntu/github/mcp-cli/.claude/worktrees/issue-3037`
- **Push status**: **ALL WORK IS PUSHED.** Working tree clean, 0 unpushed commits, local head == `origin/feat/issue-3037-work-items-domain`. Nothing is at risk from worktree removal.

## Status

Everything is done and pushed. Nothing unfinished, nothing uncommitted.

Last full `bun run am-i-done`: **green** (properly leased, not fail-open). `bun run doing-it-wrong`: no violations. Last CI run was green on all five checks at `65593efa`; **CI has NOT been run on `f9c5835a`** — the local gate passed and I pushed, but I did not wait for CI before the freeze/shutdown. That is the one unverified thing.

Five commits on top of `main` (`88b78bf5`):

| SHA | What |
|---|---|
| `b306ad13` | core: scope work_items + `_work_items` by domain |
| `0d9c5eaa` | round 1: canonical-id phase-state namespace; closed the rule's own bypass |
| `e7e9172b` | test: prove production supplies the id the untrack double assumes |
| `c3f85848` | round 2: daemon-internal readers are ring 0, not startup-scoped |
| `f9c5835a` | simplification: deleted the round-3 seam; scope reduced |

## Where I stopped

Standing down for the operator's per-PR disposition (merge / simplify once / park), which never arrived before shutdown. **The next action I would have taken**: nothing on my own initiative — I had assessed my full remaining list against the new (a)/(b)/(c) blocking bar and nothing on #3175 meets it. If told to push again, the only thing I would fold in is the one-character fix in "Unfiled findings" #1 below.

## Merge constraint — READ THIS BEFORE MERGING #3175

**#3175 must merge AFTER #3160 (which ships `mcx domain` CLI, issue #3035).** This is not stylistic. Verified by probe, not reasoning:

- Imported work items all arrive at `domain_id = 0`. This is stated in the code: `packages/daemon/src/db/import-legacy.ts` ~line 523 — *"a column present only in the new schema takes its default (that is how every `domain_id` arrives as the unassigned sentinel)"*.
- `importScopesAsDomains` creates a domain row per `~/.mcp-cli/scopes/*.json` on **every daemon boot, with no user action**. This box has `gerald.json`.
- Result after #3175 lands: a user standing **inside their own project** sees **0 work items** where they previously saw them. Probe output:
  ```
  caller INSIDE the project sees : 0 item(s)      <-- was 1 before the PR
  caller OUTSIDE every domain sees: 1 item(s)
  ring-0 daemon reader sees      : 1 item(s)
  ```
- Recovery needs `mcx domain rm`, which has not landed. Re-tracking **makes it worse** (per-domain uniqueness means it creates a second row while the original stays stranded). Only real recovery today is raw `sqlite3`.
- Mitigated but not eliminated: the response now carries `unassignedCount` + a note instead of a bare empty list, and `mcx tracked` says so.
- **Not** data loss and **not** a pipeline break — rows are intact and readable from outside, and the daemon's own machinery is ring 0 so pollers/CI/automation still see every row.

## Unfiled findings — last chance for these to survive

**1. Wrong issue cross-reference in shipped comments (mine, introduced in `f9c5835a`).**
`packages/daemon/src/index.ts` lines **471, 857, 987, 1325** say `see #3193`. They mean **#3192**. #3193 is an unrelated issue (`domain-mutation-invalidates-resolver` lint rule), so a reader following the pointer lands somewhere misleading. One-character fix, four places. Recorded on the PR; **never filed as an issue**. Below the (a)/(b)/(c) bar, which is why I left it — not because I forgot.

**2. The partition-closure risk has NO issue of its own.**
It is described in the PR body and in mail to boss, and it is the reason for the #3160 merge order above, but nothing tracks it independently. If #3175 merges without #3160, or if the merge-order note is lost, there is no issue to catch it. Worth filing with the probe output above.

**3. `mcx scope add` stores `root: cwd` with no git-root check.**
`packages/command/src/commands/scope.ts:104`. Combined with `resolveDomainForPath`/`isPathWithin` (`packages/core/src/domain.ts`) permitting a domain registered at a **strict ancestor** of the repo, this makes `domain.path == git root` an assumption that is *never* safe. It is mentioned inside #3209 but there is no issue for the validation gap itself. This is the legality that caused round 3 of this PR; it will bite anything else that assumes a domain path is a repo root.

**4. A test in this PR's own history could never fail** (already deleted, recorded in #3209 — noting here so the lesson is not lost): `domain-scope.spec.ts` asserted `domainStateRoot()` returned what a hand-built fake was constructed to return. It pinned the implementation to itself. It went out with the code it tested.

## Things I know that are not written down elsewhere

- **`recordTransition` had two independent fixes.** Merged `main` fixed the missing `domain_id` writer with `COALESCE((SELECT domain_id FROM work_items WHERE id = ?1), 0)`. I resolved the rebase conflict **in favour of the handle's own `domainId`** — on a domain-bound handle the writing domain *is* the authority, it drops a per-insert subquery, and main's `COALESCE(..., 0)` silently re-lands the sentinel if the parent row is missing (the exact "confident zero" its own comment condemns). Main's rationale comment was kept. Anyone diffing against main will see this and should not "restore" the subquery.
- **`domains.spec.ts` "an 11th cannot be added silently" is no longer a tautology.** It derives from the live schema via `listPartitionedTables(raw)` and has a sibling test proving the derivation bites. #3040 can rely on it.
- **Rebasing this branch requires `--onto`.** `git rebase origin/main` conflict-storms because #3143 was squash-merged; resolving that storm silently reverts the #3034 repair. Correct: `git rebase --onto origin/main <old-base>`. I hit this and aborted rather than resolving.
- **`packages/daemon/src/db/state.ts` and `import-legacy.ts` are byte-identical to `main`.** I never touched either. Verified with `git diff origin/main --stat`.
- **`.claude/phases/*.ts` deliberately untouched and `.mcx.lock` not regenerated.** The issue text asked for phase-script updates; the implicit-scoping design makes them unnecessary (the daemon scopes from the caller's cwd, so no phase script passes a domain). Agreed with the orchestrator. `ctx.domain` + `docs/phases.md` are the correct surface and both shipped.
- **The `_meta` channel is the reusable piece for epic D.** The caller's domain travels in MCP `_meta`, a sibling of `arguments`; the IPC zod schema strips unknown keys, so a session cannot forge it. `_cards` will want exactly this. Constants and helpers live in `packages/daemon/src/domain-scope.ts` (`DOMAIN_META_KEY`, `DOMAIN_SCOPED_SERVERS`, `domainScopeFromMeta`).
- **Unresolved scope in my code fails CLOSED**, unlike the #3199 bye bug. Absent/malformed `_meta` all collapse to `NO_DOMAIN_ID` — a real, narrow partition, never "no filter". Cross-domain access exists only behind the explicitly named `WorkItemDb.acrossDomains()` and is unreachable from a resolution failure. Pinned by tests in `domain-scope.spec.ts` ("unresolved scope fails closed, not open (#3199 class)") so a future change cannot quietly make it permissive.
- **Confirmed the gate-lease fail-open (#3138) live**, twice: `gate-lease: no admission within 275329ms — proceeding unleased` sitting above an otherwise green result.

## Issues filed / updated from this work

Filed: **#3209** (five-way `repo_root` divergence), **#3192** (daemon `process.cwd()` startup bindings), **#3172** (TLS/openssl 5000ms contention flake), **#3165** (`ctx.domain.name` null under `mcx phase run`).
Data points added: **#3040** (alias_state dual-writer pair), **#3014**, **#3118**, **#2915** (CI segfault after the 60-worker repro test).

## What #3175 claims, precisely

> `work_items` and the `_work_items` server are partitioned by domain; daemon-internal readers are ring 0; the phase-state **namespace** is derived once.

It does **not** claim anything about phase-state **roots** or repo identity — that scope was deliberately deleted in `f9c5835a` and handed to #3209.

## Late additions (post-shutdown-report)

**#3034's one unfiled defect is CLOSED by this branch.** The #3034 worker (state file `kurt.md`) recorded: *"work_item_transitions creation row is stranded at domain_id=0 because createWorkItem has no domain param, so countDomainDependents under-counts and a cascade orphans it. My own test passes by excluding it. Closes when #3037 gives createWorkItem a domain."*

That is done at `f9c5835a`. `DomainWorkItems.createWorkItem` writes `domain_id` from the handle, so the creation transition carries the domain like every other row. I ported their Y5 test in `domains.spec.ts` from asserting **2** domain-carrying transition rows to **3**, and `countDomainDependents` from 2 to 3, precisely because the exclusion they describe is no longer needed. **Whoever merges #3175 can consider that concern resolved; whoever reads `kurt.md` should be pointed here.**

**DX papercut, unfiled: `mcx mail` sends on unrecognised subcommands instead of erroring.**
`mcx mail read 95` — intending to read message 95 — **sent an empty message** (id 97, "(no subject)") by treating `read` and `95` as recipient names. `mcx mail --help` documents `-u <user>` for reading and says "Mailboxes are created implicitly on first send", so an unknown recipient can never be a typo. A send is not a safe default for an unparsed command: it is visible to other agents and cannot be withdrawn. Suggested fix: reject positional recipients that collide with known subcommand-ish words, or require `-s` for any send so a bare `mcx mail <word> <word>` errors instead of transmitting. **Message 97 in the boss mailbox is this artefact, not content — ignore it.**

Also note the send of message 95 emitted ``error: option `onto' requires a value`` to stderr, caused by the literal text ``git rebase --onto`` appearing in the piped body. The body still transmitted intact (stdin is not arg-parsed) and the header/subject are correct, but something in the path is scanning message text for flags. Same family as the papercut above.
