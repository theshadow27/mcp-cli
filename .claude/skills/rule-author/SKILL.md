---
name: rule-author
description: Author, refine, or migrate a doing-it-wrong architectural rule. Use when the user wants to "write a rule", "add a lint rule", "should we lint for this", "make a rule for X", "migrate a check-*.ts into the rule engine", or when a recurring mistake (often surfaced by harvest-rules) should be mechanized. Also covers judging whether a proposed rule is worth writing and bootstrapping the rule engine into a new repo.
---

# Rule Author

## Why rules exist

A rule mechanizes a recurring mistake so review rounds and CI minutes are spent on judgment, not on catching the same avoidable bug again and again. Rules are part of the project's **definition of done**: the `doing-it-wrong` sweep runs inside `am-i-done`, which is the *single* gate executed identically at pre-commit and in CI. That's the whole value — it **shifts failures left**: a violation fails in seconds on the author's machine instead of surfacing minutes later in CI (or worse, never, if the gate is incomplete). And because mcp-cli is built by autonomous agents, rules are **agentic guardrails**: an implementer that doesn't know a convention gets caught mechanically instead of shipping the mistake into main. One rule is one `scripts/rules/<id>.rule.ts` file — **not** a new `package.json` script. New rules go behind the single `doing-it-wrong` / `am-i-done` entry points.

## When to use this skill

- Writing a new rule from a known recurring mistake (e.g. a harvest-rules finding).
- Refining a rule that's too broad (false positives) or too narrow (misses the shape).
- Judging whether a proposed invariant *should* be a rule at all.
- Migrating a legacy standalone `scripts/check-*.ts` into the engine.
- Standing the engine up in a new repository.

## References

- **`references/new-rule.md`** — how to author a `.rule.ts`: the API, regex-vs-AST decision, fixtures (minimal, not elaborate), writing guidance that names the cause, and the add-rule→show-red→remediate-in-the-same-PR discipline.
- **`references/rule-engine.md`** — a from-scratch description of the engine (every `_engine/` component, the entry scripts, and how the gate is wired). Use this when copying the engine to a new repo so you don't re-derive the layout each time.

## Is this a good rule?

Before writing, check all four. If any fails, refine the proposal or say so — a bad rule is worse than no rule, because every false positive teaches people to suppress reflexively and erodes trust in the whole sweep.

1. **Mechanically enforceable.** The mistake must be a *shape* a regex or the TS AST can match — "raw `Bun.spawn` instead of the helper", "`expect(x.filter(...)).toHaveLength(0)`". If detecting it requires understanding intent or design quality ("is this abstraction right?"), it is a code-review concern, not a rule. Decline or narrow it to the mechanizable core.
2. **Precise.** Aim for near-zero false positives. A noisy rule gets `// dotw-ignore`'d on sight and becomes decoration. If you can't get precision with a regex, use the AST (`references/new-rule.md`); if you still can't, the rule isn't ready.
3. **Has a real alternative.** A rule that bans something must point at the right way to do it — ideally a shared helper that handles the corner cases, so "do it right" is easier than "do it wrong". A ban whose only escape is an unbounded `// dotw-ignore: long-running, you're on your own` is not a guardrail; it just moves the risk behind a comment. If the right answer is "use a helper that doesn't exist yet", build the helper (or file it) as part of the work.
4. **Recurring.** One-offs don't earn a rule. The bar is roughly "a reviewer has flagged this more than twice" (see the `harvest-rules` skill). A single incident is a fix, not a rule.

Borderline cases worth refining rather than rejecting: a rule that's *mostly* mechanizable but has a few legitimate exceptions (give it precise detection + a documented suppression), or one that overlaps an existing rule (resolve the overlap — don't ship two rules that fight over the same lines).
