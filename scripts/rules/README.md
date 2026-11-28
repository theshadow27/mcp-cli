# doing-it-wrong rules

This repo's architectural rules, run by the [`am-i-done`](https://github.com/theshadow27/am-i-done)
package's rule engine: `bun run doing-it-wrong` on its own, and as the `rules` stage of
`bun run am-i-done`. The package's README ("Rules") is the reference for the DSL; `done.toml`
(`[rules]`) sets what the rules scan and how they parse.

## Layout

```
scripts/rules/
  *.rule.ts          One rule per file, default-exports a Rule (`satisfies Rule` from "am-i-done")
  fixtures/          <rule-id>__<scenario>.<ext>.fixture, or a scenario directory
                     <rule-id>__<scenario>/ holding a small project for a rule that looks across files
```

The package's built-in rules (`bun run doing-it-wrong --list`) run alongside these.

## Rule types

- **`pattern`**: a global regex over code (comments and string literals are masked unless the rule
  sets `scope`).
- **`check`**: a function over the file (`ctx.file`), every loaded file (`ctx.files`, keyed by
  relative path), the syntax tree (`ast: true`, `ctx.ast()`, TSESTree parsed by oxc) and the import
  graph (`ctx.graph()`). It returns `ctx.checked()` or `ctx.skipped()` on every path.
- **`import`**: a regex over import specifiers.

On a full run every rule must inspect at least one file (`expected`, default 1), and every
`anchors` predicate must find its marker, so a rule whose target moved fails instead of passing.

## Fixtures

Every rule has at least one fixture that fires. A fixture names its expected count and the path the
rule should believe it has in its first lines:

```ts
// @expect 2
// @path packages/daemon/src/example.ts
```

Fixtures run on every sweep, so a rule that stops catching what it was written for fails.

## Suppression

```ts
// doing-it-wrong-ignore <rule-id>: <reason> (#<issue>)
```

It covers its own line and the two below; `doing-it-wrong-ignore-file <rule-id>: <reason> (#<issue>)`
covers its file. The reason must cite the issue that tracks the exception. A suppression that no
longer suppresses anything is itself a violation, and CI's `stale-todos` stage fails on one whose
issue is closed. Suppressions carried over from the old `dotw-ignore` form cite #3465.

## Adding a rule

1. Create `scripts/rules/<id>.rule.ts`.
2. Add fixtures in `scripts/rules/fixtures/`: at least one that fires and one that does not.
3. `bun run doing-it-wrong --rule <id>` to iterate, then `bun run am-i-done`.
