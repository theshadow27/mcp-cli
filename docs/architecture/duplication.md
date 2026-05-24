# Duplication and abstraction (for a Claude-maintained codebase)

This codebase deliberately tolerates more duplication than human style guides
recommend, and abstracts in a different *place* than typical OO. That is not
naïveté about DRY — it's a deliberate adaptation to who maintains this code.
Read this before "fixing" duplication, and before writing a rule that bans it.

## Why DRY is a human optimization

DRY exists to relieve constraints that bind *human* maintainers:

- A person's working memory can't hold N call sites, so "change it in one
  place" is precious.
- Mechanically editing N duplicated sites is tedious and error-prone for a
  person, so indirection is a fair price.

Both costs largely collapse for a Claude maintainer. Claude can grep all N
mirrors and edit them consistently in a single pass — the primary *benefit* of
abstraction (cheap, consistent multi-site change) is cheap anyway. Meanwhile
abstraction's *costs* get worse: indirection destroys locality, and locality is
exactly what a context window rewards. A self-contained, mirrored file reads
cleanly into context and can be reasoned about — or **regenerated wholesale** —
in isolation. A heavily-abstracted call site forces traversal across files to
reassemble behavior, burning context and risking a missed constraint.

The deepest version: abstraction optimizes for cheap *editing* of a long-lived
artifact; Claude can do cheap *regeneration*. If the unit of maintenance is
"throw the file away and rewrite it from spec + tests," you don't need a shared
abstraction to amortize edits — you're not editing, you're regenerating. And
duplication preserves optionality: extracting an abstraction later is easy;
un-picking a wrong one is the expensive direction (Sandi Metz: "duplication is
cheaper than the wrong abstraction").

## The seam: abstract the nouns, duplicate the verbs

Look at how this repo is actually structured. The **nouns** are abstracted —
shared data contracts (`session-types.ts`, the unified session state machine,
`MonitorEvent`, work-item types). The **verbs** are duplicated — per-provider
session logic (codex / acp / opencode / mock) is mirrored rather than unified
behind a base class or strategy hooks.

That is a more robust seam than typical human OO, which abstracts the verbs
(inheritance, strategy callbacks, framework hooks) and thereby creates the
coupling pain. **Sharing data contracts is low-coupling and high-value; sharing
behavior is where lock-in and blast-radius live.** Drawing the line at the noun
is drawing it at the more robust place.

## The decision rule

> **Abstract what changes together. Duplicate what changes independently.**

This is measurable, not philosophical. For any set of mirrored files, mine git
history: how often does a commit touch *all* of them together vs. one at a time?

- **Co-change** (commits routinely touch all siblings together) → miscategorized
  duplication. The invariant wants to live in one place; extract it. The
  recurring-bug clusters mined by `/harvest-rules` are exactly this signal — the
  same fix landing in many independent PRs means the concern changes in lockstep.
- **Independent drift** (siblings evolve separately) → *validated* duplication.
  Leave it. An abstraction here would only add coupling.

So invariant-bearing **plumbing verbs** — spawn hygiene, error extraction,
pagination, migration safety, flag parsing — are fair to abstract: they carry a
correctness invariant and the survey shows they co-change. **Domain verbs** that
diverge per case (the per-provider session logic) are not.

## The one real cost: unenforced invariants → silent drift

N files parallel *by convention* have nothing forcing them to stay parallel.
The compiler won't tell you when mirror #9 quietly diverges. The scary case
isn't a feature drifting — it's a **correctness or security fix that lands in 7
of 8 transports**. That is the failure mode mirrors are exposed to and
abstraction is not.

The fix is **enforcement at the process layer, not the type layer**: keep the
duplication's locality and regenerability, but don't fly blind on drift.

- **Manual mirror-replay check (today):** in review, when a fix touches a file
  that has known mirror-siblings, ask explicitly *"did this fix get replayed
  across all siblings?"* See the `adversarial-review` Focus Areas.
- **Co-change / drift detector (future, not built):** a git-history miner —
  sibling of `/harvest-rules` — that flags commits touching some-but-not-all
  siblings. That is the security-fix-not-replayed detector. Documented here as
  the intended instrument; we run the manual check until it earns building.
- **Hand-built invariant checks (today):** where a mirror set's parallelism is
  load-bearing, a `doing-it-wrong` rule can enforce it directly — e.g. the
  CLI-surface registry check (every dispatch case must appear in `SUBCOMMANDS`
  and usage). That *instruments* the mirrors instead of collapsing them.

## What this means for `doing-it-wrong` rules

A rule must **mechanize an invariant**, never enforce DRY for its own sake.

- ✅ Good: "every `Bun.spawn` must have a timeout + drained pipes + honest
  exit-code handling" (a safety invariant), enforced via a shared helper.
- ❌ Bad: "no two files may contain similar code" (DRY dogma) — this would force
  de-duplication of independently-changing verbs, the expensive wrong direction.

When a rule's alternative is "use shared helper X," it's justified only because
the thing it factors out is a co-changing invariant. Word the rule's `guidance`
around the *invariant* (correctness, safety, drift), never around "don't repeat
yourself." Importing human DRY dogma here is cargo-culting a principle whose
justification doesn't apply to this maintainer.
