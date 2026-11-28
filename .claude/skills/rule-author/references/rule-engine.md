# The rule engine (for bootstrapping a new repo)

The `doing-it-wrong` engine and the `am-i-done` gate around it are the published `am-i-done` package (`bun add -d am-i-done`). Do not copy engine source into a project: install the package, and read its README (Rules, Suppression, Fixtures) for the reference. It is Bun-only and ships TypeScript source, so `node_modules/am-i-done` is readable.

## Layout (this repo)

```
done.toml                  gate config: [run], [stages], [rules], [suppression], [cache]
scripts/
  stages/
    *.stage.ts             one stage per file (test-changed, coverage, stale-todos, ...)
    _lib/                  helpers shared by stages (e.g. lease.ts)
  rules/
    <id>.rule.ts           one rule per file, default export `satisfies Rule`
    fixtures/
      <id>__<scenario>.<ext>.fixture    single-file fixture
      <id>__<scenario>/                 scenario directory (a small project) for cross-file rules
    README.md              this repo's rule conventions
```

`package.json` carries two scripts: `am-i-done` (`bun install --frozen-lockfile --silent && am-i-done`) and `doing-it-wrong` (the rule engine alone).

## What the package provides

- **The gate (`am-i-done`)** — runs stages (built-ins `bun-version`, `lint`, `typecheck`, `rules`, `test`, plus every `scripts/stages/*.stage.ts`) in an order derived from what each declares, under per-stage and whole-run deadlines. Modes: `--pre-commit`, `--pre-push`, `--ci` (default under CI); `--only <stage>` / `--from <stage>` rerun part; `--list` prints the plan. A failing stage is rerun once to diagnose flakes. Under an agent harness (`CLAUDECODE`) the console gets one line per stage and the detail goes to `.am-i-done/run-*.log`.
- **The rule engine (`doing-it-wrong`)** — loads the built-in rules and every `scripts/rules/*.rule.ts`, scans the files `done.toml` `[rules]` selects, and reports violations grouped by rule: the `scold` and `guidance` once per rule, `file:line:column` plus snippet per violation. `bun run doing-it-wrong --list` shows rules by category; `--rule <id>` runs one; paths narrow the files. Exit code is nonzero on any violation, which is the gate's source of truth.
- **Rule types** — `pattern` (global regex over code), `import` (regex over import specifiers), `check` (a function over `ctx`; `ast: true` gives `ctx.ast()`, a TSESTree parsed once per file by oxc; `ctx.graph()` gives the import graph). See `new-rule.md` for the fields.
- **Liveness** — on a full run every rule must `checked()` at least `expected` files (default 1) and every `anchors` predicate must find its marker, so a rule whose target moved fails instead of passing. This is why check rules must return `ctx.checked()` / `ctx.skipped()`.
- **Fixtures** — every rule needs at least one that fires; they run on every run, so a rule that stops catching its shape fails. Directives `// @expect N` and `// @path p`; the `.fixture` suffix keeps tooling away from deliberately wrong code.
- **Suppression** — `// doing-it-wrong-ignore <rule-id>: <reason> (#<issue>)` covers its own line and the two below; `doing-it-wrong-ignore-file` covers the file. The issue is required, and an unused suppression fails. A file that cannot carry a comment is waived with `[[suppression.waive]]` in `done.toml`.

## Wiring — the load-bearing step

**The engine does nothing unless the gate runs it.** This is the single most important lesson (mcp-cli #2344): sprint 62 shipped rules with green fixtures, but the sweep ran in neither pre-commit nor CI, so violations piled up invisibly and the rules were inert.

`bunx am-i-done init --hooks` writes the git hooks (`pre-commit` runs `am-i-done --pre-commit`, `pre-push` runs `--pre-push`) and sets `core.hooksPath`. Wire CI to run `bun run am-i-done` (`--ci` is implied). The hook is bypassable via `--no-verify`, web edits and force-push; CI is the unforgettable backstop. Run the **same** command in both so local and CI share one definition of done and a violation fails in seconds locally, never for the first time in CI.

## Bootstrapping a new repo

1. `bun add -d am-i-done`, then `bunx am-i-done init --hooks` (writes `done.toml`, an example rule with fixtures, `scripts/stages/`, the two package.json scripts, a `.gitignore` entry and hooks; it never overwrites an existing file).
2. Set `[rules] include` in `done.toml` to the new repo's source layout, and `categories` if you want your own.
3. Wire `am-i-done` into CI (see above).
4. Write the first rule + a minimal fixture pair (`new-rule.md`), confirm `bun run doing-it-wrong` (exit 0) and `bun run am-i-done` pass.
5. Seed real rules from `/rule-author harvest` findings rather than inventing invariants speculatively.
