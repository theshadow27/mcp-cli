# Writing a rule

## 1. The file

One rule = one file: `scripts/rules/<id>.rule.ts`, default-exporting a `Rule` from `am-i-done`. The engine autoloads every `*.rule.ts` (no manual registry). The `<id>` is the stable identifier used in reports and suppression comments; keep it short, kebab-case, and matching the filename prefix.

```ts
import type { Rule } from "am-i-done";

export default {
  id: "no-raw-spawn",
  type: "check",
  category: "architecture",
  ast: true,
  scold: "raw Bun.spawn/spawnSync — use spawnCapture() from @mcp-cli/core",
  guidance: [ /* see §4 */ ],
  documentation: "#2269",       // optional: issue / PR / CLAUDE.md anchor
  tests: "exclude",             // optional: "exclude" | "only"; default both
  check(ctx) { /* ... */ return ctx.checked(); },
} satisfies Rule;
```

### The API (`Rule` in `am-i-done`)

Fields shared by every rule:
- `id: string` — stable; used in suppressions and `--rule <id>`.
- `type: "pattern" | "check" | "import"`.
- `category: string` — a key of `[rules] categories` in `done.toml`.
- `scold: string` — one-line "what's wrong", shown once per rule in the banner.
- `guidance: string[]` — "how to fix" bullets, shown once per rule (not per violation).
- `documentation?: string` — pointer (issue/PR/anchor).
- `tests?: "exclude" | "only"` — scope by test files.
- `files?: string[]` — globs that widen what the rule sees beyond source (a `Dockerfile`, YAML, a markdown spec).
- `anchors?: ((files) => boolean)[]` — predicates over the loaded file set. On a full run each must find its marker somewhere in the tree, and in the rule's fixtures. Use for **cross-file rules** that read a sibling file, so a rename silently no-opping the rule becomes a failure (e.g. `anchors: [(files) => files.has(SPEC_REL_PATH)]`).
- `expected?: number` — liveness: on a full run the rule must `checked()` at least this many files (default 1). Set `0` only for a rule with nothing to inspect yet.

Three types:
- **`pattern`** — `{ type: "pattern", pattern: RegExp }`. A global regex over code; matches inside comments and string literals are ignored unless the rule sets `scope: "all"` (or `"comments"`, for directives). Each match reports `line:column`.
- **`import`** — `{ type: "import", pattern: RegExp }`, matched against import specifiers.
- **`check`** — `{ type: "check", check(ctx) }`. `ctx` provides:
  - `ctx.file` — the current file: `relativePath`, `content`.
  - `ctx.files` — all loaded files, keyed by relative path (a `Map`), for cross-file checks.
  - `ctx.violated(line, column, snippet)` — once per violation, 1-indexed.
  - `ctx.checked()` / `ctx.skipped()` — **every path must return one**: `checked()` when the rule inspected the file, `skipped()` when it was out of scope. The return type is a brand only the engine mints, so a bare `return` does not compile, and a rule whose target moved fails the liveness check instead of passing silently.
  - `ctx.ast()` — with `ast: true`: the file's TSESTree (parsed by oxc, once per file, shared); `ctx.ast(path)` for another loaded file's. `walk` and the `TSESTree` types are exported from `am-i-done`.
  - `ctx.graph()` — the project import graph (`importers`, `closure`, `cycles`).

## 2. Regex or AST?

**Use a `pattern` rule** when the mistake is a single-line lexical shape with low false-positive risk: `execSync(\`...${x}...\`)`, a banned import specifier, a forbidden call on one line. Cheapest to write and read.

**Use a `check` rule with `ast`** when the shape is structural, spans nodes, or a regex would be a guessing game:
- multi-line constructs (a callback body, an `if`-guard and the assertion inside it),
- "call to X where the receiver is `Bun`" (precise callee/receiver matching),
- "discriminant asserted *outside* this `if`" (relationship between nodes),
- anything where comments/strings would create false matches.

The tree is TSESTree with `range`, `loc` and `parent` on every node. Use `walk(ctx.ast().program, (node) => …)` to visit nodes, `node.loc.start` for `violated`, and `file.content.slice(...node.range)` for a snippet. Optional chains arrive as a `ChainExpression` wrapper; look through it.

Rule of thumb: if you're writing a regex with three lookaheads to avoid false positives, stop and use the AST. The `no-raw-spawn`, `timer-callback-error-boundary`, and `test-unguarded-narrowing` rules are good `check`+`ast` references; `shell-injection` is a good `pattern` reference.

### Scoping

Gate inside `check` on `ctx.file.relativePath` when a rule only applies to part of the tree — e.g. `if (!ctx.file.relativePath.startsWith("packages/daemon/src/")) return ctx.skipped();`, or a single-file rule with `if (ctx.file.relativePath !== "…/phase.ts") return ctx.skipped();`. What the engine scans comes from `done.toml` `[rules]` (`include`/`exclude`, plus `.gitignore`); `tests: "exclude"` skips test files.

## 3. Fixtures — minimal, not elaborate

Every rule needs at least one fixture that fires; the engine checks fixtures on every run and fails if a rule has none or the violation count differs. A fixture is a file with a `.fixture` suffix (so the type checker, linter and test runner ignore code that is wrong on purpose):

`scripts/rules/fixtures/<rule-id>__<scenario>.ts.fixture`

```ts
// @expect 1
// @path packages/command/src/example.ts

// the smallest snippet that exhibits the shape:
const proc = Bun.spawn(["git", "status"]);
```

- The filename prefix (before `__`) is the rule id. `// @expect N` is the exact count (default 0). `// @path` is the synthetic path the rule sees — it controls scope gating, so set it to a path your scope check accepts. Both are comment lines of their own in the first lines.
- A rule that looks across files gets a **scenario directory** `<rule-id>__<scenario>/` holding a small project: each file at its path with `.fixture` appended, each with its own `// @expect`. Each of the rule's `anchors` must find its marker in the rule's fixtures.
- **Keep fixtures minimal.** The goal is to exercise the *shape*, not reproduce a real bug. One small clean fixture (`@expect 0`) proving the rule does NOT fire on the good pattern, and one flagged fixture (`@expect N`) proving it DOES. Add a third only for a genuine edge the rule handles specially (a near-miss that should be safe, a suppression). Don't build elaborate scenarios — they obscure what's under test and rot.
- Both polarities are first-class: `@expect 0` fixtures catch the regression where a regex tightens and stops matching intended targets.
- Suppression is applied at the fixture boundary too: a fixture containing `// doing-it-wrong-ignore <id>: <reason> (#<issue>)` must be `// @expect 0`.

## 4. Guidance that names the cause

This is the part most worth getting right. **Name the failure mechanism, then give non-exhaustive examples. Do not prescribe a single move.** A recipe ("just do X") leaves the reader pattern-matching instead of understanding — they can't generalize, and they can't recognize the legitimate exception. Two real failures from this codebase:

- A fixing agent burned nine paragraphs deliberating between two prescribed `test-filtered-assertion` fixes because the guidance said "do A or B" with no *why*. Making it more prescriptive made it worse. The fix was to explain the cause — *"filtering is subtractive: anything you filtered out can never fail the test, so it only proves the bad thing you searched for is absent, never that the output is correct"* — from which the right move is obvious.
- A `no-raw-spawn` agent nearly suppressed a site because the helper lacked an `env` option. The guidance now spells out what the helper handles (missing-binary throw, pipe-deadlock draining, timeout→SIGKILL, null exitCode) so the cost of reimplementing is visible, and says explicitly: *if the helper lacks an option, extend it — a missing option is not a reason to suppress.*

Structure:
- `scold` — the one-line "what's wrong".
- `guidance[0]` — the mechanism of harm (the *why*).
- `guidance[1..]` — "examples of doing it right (not exhaustive): …", and for ban-and-replace rules, when the escape hatch (`// doing-it-wrong-ignore`) genuinely applies.
- `documentation` — the issue/PR for the full story.

## 5. Rollout: add rule → show red → remediate in the SAME PR

A rule and the cleanup of its existing violations land **together**. This is non-negotiable for two reasons, both learned the hard way (#2344):

- **Don't merge a rule that leaves the tree red** — the gate now blocks everyone's commits/CI on pre-existing debt that isn't their fault.
- **Don't merge a rule that isn't swept by the gate** — sprint 62 shipped rules with green fixtures but the sweep ran nowhere, so 93 violations accumulated invisibly and the rules did nothing.

Workflow:
1. Write the rule + minimal fixtures.
2. `bun run doing-it-wrong --rule <id>` — see every existing violation (`--list` shows all rules).
3. Remediate each: fix it, or suppress with a reason where the construct is genuinely correct:
   - `// doing-it-wrong-ignore <id>: <reason> (#<issue>)` — the issue that tracks removing the exception is required; there is no separate "todo" form. It covers its own line and the two below; `doing-it-wrong-ignore-file` covers the file. A suppression that no longer suppresses anything fails the run.
   - a file that cannot carry a comment (generated code, JSON) is waived in `done.toml` with `[[suppression.waive]]` (`rule`, `file`, optional `match`, `reason` citing an issue).
4. `bun run doing-it-wrong --rule <id>` → clean. Then the full gate: `bun run am-i-done`. **Trust the exit code, not a grep of the output** (a single violation prints "1 violation", which a plural-only grep misses).
5. Fixtures run as part of the `rules` stage; `bun run am-i-done --only rules` confirms them.

When remediating a large rule across many files, partition by package and delegate the repetitive edits to per-package agents — but enumerate **all** packages (it's easy to miss one), and tell each agent to run `bun run am-i-done` before reporting, not a hand-picked subset of checks.
