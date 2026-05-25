# Writing a rule

## 1. The file

One rule = one file: `scripts/rules/<id>.rule.ts`, default-exporting a `Rule`. The loader autoloads every `*.rule.ts` (no manual registry — `index.ts` just re-exports the loader). The `<id>` is the stable identifier used in reports and suppression comments; keep it short, kebab-case, and matching the filename prefix.

```ts
import type { CheckRule } from "./_engine/rule";

const rule: CheckRule = {
  id: "no-raw-spawn",
  kind: "check",
  scold: "raw Bun.spawn/spawnSync — use spawnCapture() from @mcp-cli/core",
  guidance: [ /* see §4 */ ],
  documentation: "#2269",       // optional: issue / PR / CLAUDE.md anchor
  appliesToTests: false,        // optional, default true
  check({ file, violated, ast }) { /* ... */ },
};
export default rule;
```

### The API (`_engine/rule.ts`)

`RuleBase` fields, shared by both kinds:
- `id: string` — stable; used in suppressions and the registry.
- `scold: string` — one-line "what's wrong", shown once per rule in the banner.
- `guidance: string[]` — "how to fix" bullets, shown once per rule (not per violation).
- `documentation?: string` — pointer (issue/PR/anchor).
- `appliesToTests?: boolean` — when `false`, `*.spec.ts`/`*.test.ts` are skipped. Default `true`.
- `anchors?: readonly string[]` — repo-relative paths that MUST be in the loaded file set. The engine validates these in `runRules` *before* invoking `check()` and hard-errors with `MissingAnchorError` if any are absent. Use for **cross-file rules** that read a sibling file — without this, a rename or `--filter` narrowing silently no-ops the rule and reports a false-confidence pass (#2315). Anchors are advisory in direct `evaluateRule` callers (unit tests); only `runRules` enforces them.

Two kinds:
- **`PatternRule`** — `{ kind: "pattern", pattern: RegExp, except?: string[] }`. The engine runs the regex per-line (forces `/g`), reports each match as `line:column`. `except` is a list of substrings that, if present on a matched line, exempt it.
- **`CheckRule`** — `{ kind: "check", check(ctx) }`. `ctx` is `{ file, files, violated, checked, ast }`:
  - `file: FileMeta` — `{ path, relPath, content, pkg, isTest }`. `pkg` is `"packages/<name>" | "scripts" | "test" | ""`.
  - `files: Map<string, FileMeta>` — all loaded files, for cross-file checks.
  - `violated(line, column, snippet)` — call once per violation. 1-indexed line/column.
  - `checked()` — call when the rule performs real inspection work (not an early return). The runner aggregates per-rule counts; a rule that scanned >0 applicable files but signalled zero inspection logs a debug `silent-pass` warning. Crucial after a refactor/rename so a regression doesn't slip through as a clean pass.
  - `ast: AstHelper` — lazily parsed (only on first access; nothing is paid if you don't touch it).

## 2. Regex or AST?

**Use a `pattern` rule** when the mistake is a single-line lexical shape with low false-positive risk: `execSync(\`...${x}...\`)`, a banned import specifier, a forbidden call on one line. Cheapest to write and read.

**Use a `check` rule with `ast`** when the shape is structural, spans nodes, or a regex would be a guessing game:
- multi-line constructs (a callback body, an `if`-guard and the assertion inside it),
- "call to X where the receiver is `Bun`" (precise callee/receiver matching),
- "discriminant asserted *outside* this `if`" (relationship between nodes),
- anything where comments/strings would create false matches.

`AstHelper` (`_engine/ast.ts`) gives you:
- `sourceFile` — the `ts.SourceFile`; drop to the raw TS API when needed.
- `find(guard)` — all descendants matching a `ts.is*` type guard.
- `findByKind(kind)` — all nodes of a `SyntaxKind`.
- `callsTo(name)` — `CallExpression`s whose callee is `name` (identifier or `.name`).
- `positionOf(node)` → `{ line, column }` (1-indexed) for `violated`.
- `stringLiterals(node)` — string/no-substitution-template text under a node.

Rule of thumb: if you're writing a regex with three lookaheads to avoid false positives, stop and use the AST. The `no-raw-spawn`, `timer-callback-error-boundary`, and `test-unguarded-narrowing` rules are good `check`+`ast` references; `shell-injection` is a good `pattern` reference.

### Scoping

Gate inside `check` on `file.relPath` / `file.pkg` / `file.isTest` when a rule only applies to part of the tree — e.g. `if (!file.relPath.startsWith("packages/daemon/src/")) return;`, or a single-file rule with `if (file.relPath !== "…/phase.ts") return;`. The loader already skips `.d.ts`, `node_modules`, fixtures, and `*.rule.ts` files (rules don't flag themselves), and `appliesToTests:false` skips test files.

## 3. Fixtures — minimal, not elaborate

Every rule needs at least one fixture; the autoloaded `fixtures.spec.ts` fails CI if a registered rule has none, and asserts the violation count matches. A fixture is a real `.ts` file:

`scripts/rules/fixtures/<rule-id>__<scenario>.fixture.ts`

```ts
/**
 * @rule no-raw-spawn
 * @expect 1
 * @path packages/command/src/example.ts
 */

// the smallest snippet that exhibits the shape:
const proc = Bun.spawn(["git", "status"]);
```

- `@rule` must match the filename prefix (before `__`). `@expect` is the exact count. `@path` is the synthetic path the rule sees — it controls package/test gating, so set it to a path your scope check accepts.
- **Keep fixtures minimal.** The goal is to exercise the *shape*, not reproduce a real bug. One small clean fixture (`@expect 0`) proving the rule does NOT fire on the good pattern, and one flagged fixture (`@expect N`) proving it DOES. Add a third only for a genuine edge the rule handles specially (a near-miss that should be safe, a suppression). Don't build elaborate scenarios — they obscure what's under test and rot.
- Both polarities are first-class: `@expect 0` fixtures catch the regression where a regex tightens and stops matching intended targets.
- JSDoc blocks (the frontmatter and any others) are blanked to whitespace before the rule runs, with line numbers preserved — so prose in comments never triggers pattern rules, and reported lines stay aligned to the file.
- Suppression is applied at the fixture boundary too: a fixture containing `// dotw-ignore <id>: ...` must be `@expect 0`.

## 4. Guidance that names the cause

This is the part most worth getting right. **Name the failure mechanism, then give non-exhaustive examples. Do not prescribe a single move.** A recipe ("just do X") leaves the reader pattern-matching instead of understanding — they can't generalize, and they can't recognize the legitimate exception. Two real failures from this codebase:

- A fixing agent burned nine paragraphs deliberating between two prescribed `test-filtered-assertion` fixes because the guidance said "do A or B" with no *why*. Making it more prescriptive made it worse. The fix was to explain the cause — *"filtering is subtractive: anything you filtered out can never fail the test, so it only proves the bad thing you searched for is absent, never that the output is correct"* — from which the right move is obvious.
- A `no-raw-spawn` agent nearly suppressed a site because the helper lacked an `env` option. The guidance now spells out what the helper handles (missing-binary throw, pipe-deadlock draining, timeout→SIGKILL, null exitCode) so the cost of reimplementing is visible, and says explicitly: *if the helper lacks an option, extend it — a missing option is not a reason to suppress.*

Structure:
- `scold` — the one-line "what's wrong".
- `guidance[0]` — the mechanism of harm (the *why*).
- `guidance[1..]` — "examples of doing it right (not exhaustive): …", and for ban-and-replace rules, when the escape hatch (`// dotw-ignore`) genuinely applies.
- `documentation` — the issue/PR for the full story.

## 5. Rollout: add rule → show red → remediate in the SAME PR

A rule and the cleanup of its existing violations land **together**. This is non-negotiable for two reasons, both learned the hard way (#2344):

- **Don't merge a rule that leaves the tree red** — the gate now blocks everyone's commits/CI on pre-existing debt that isn't their fault.
- **Don't merge a rule that isn't swept by the gate** — sprint 62 shipped rules with green fixtures but the sweep ran nowhere, so 93 violations accumulated invisibly and the rules did nothing.

Workflow:
1. Write the rule + minimal fixtures.
2. `bun run doing-it-wrong --rule <id> --all` — see every existing violation.
3. Remediate each: fix it, or suppress with a reason where the construct is genuinely correct:
   - permanent: `// dotw-ignore <id>: <reason>`
   - temporary: `// dotw-todo <id>: <desc> — fix in #NNN` (the `#NNN` is required)
   - The comment applies to its own line and the line below it.
4. `bun run doing-it-wrong --rule <id>` → clean. Then the full gate: `bun run am-i-done`. **Trust the exit code, not a grep of the output** (a single violation prints "1 violation", which a plural-only grep misses).
5. Confirm fixtures pass: `bun test scripts/rules`.

When remediating a large rule across many files, partition by package and delegate the repetitive edits to per-package agents — but enumerate **all** packages (it's easy to miss one), and tell each agent to run `bun run am-i-done` before reporting, not a hand-picked subset of checks.
