# doing-it-wrong rules

Architectural rules enforced by `bun run doing-it-wrong` (and by
`bun run am-i-done`, which runs the same engine in-process).

## Layout

```
scripts/rules/
  *.rule.ts          One rule per file, default-exports a Rule object
  _engine/           Engine internals: loader, evaluator, suppression, reporter
  fixtures/          Test fixtures: <rule-id>__<scenario>.fixture.ts
  fixtures.spec.ts   Auto-loads all fixtures and asserts violation counts
```

## Rule kinds

- **`pattern`** — regex matched per-line. Simplest form.
- **`check`** — full programmatic access via `check(ctx)` callback.

## Suppression

Two comment forms suppress a violation on the same or next line:

```ts
// dotw-ignore <rule-id>: <reason>            // permanent
// dotw-todo  <rule-id>: <desc> — fix in #123 // temporary (issue ref required)
```

The `dotw-todo-needs-issue` meta-rule enforces that every `dotw-todo`
includes a `#<number>` reference.

## Adding a rule

1. Create `scripts/rules/<id>.rule.ts` exporting a `PatternRule` or `CheckRule`.
2. Add fixtures in `scripts/rules/fixtures/<id>__<scenario>.fixture.ts`.
3. Run `bun run doing-it-wrong --rule <id>` to iterate, then `bun run am-i-done`.
