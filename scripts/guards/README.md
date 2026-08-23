# guard-reachability harness

`bun run guards` mechanizes a manual review step that recurred during the
#3038 mail-domain rework (PR #3200): a reviewer found a guard in
`packages/daemon` that could be deleted entirely with all 216 tests still
passing. Its only coverage was a hand-written fake presenting a combination
of states the real dependency can't produce. Mutation-testing the guard
against that fake-based spec went red — but that only proves the fake is
wired to the guard, not that the guard is reachable from real code paths.

The fix, applied by hand: delete the guard, run ONLY the specs that use a
concrete/real dependency (not fakes), and check something goes red. If
nothing does, the guard is unreachable — either the guard or the fake is
wrong. `scripts/guards/` turns that manual step into a declarative,
CI-shaped check. See #3212.

## Deliberately distinct from `doing-it-wrong`

Rules under `scripts/rules/*.rule.ts` check code **shape**, statically —
regex/AST over source text, no execution. This harness checks whether a
guard is **reachable at runtime** — it mutates a real file on disk and runs
real tests against it. Different question, different mechanism, and
correspondingly NOT part of `bun run doing-it-wrong` or `bun run am-i-done`.

## Cost, honestly

Each registered guard is a full `bun test <concreteSpecs>` subprocess
invocation. This is N full spec-file runs, not a static scan — expect it to
take real wall-clock time as the manifest grows. That's why it's a separate
`bun run guards` command rather than folded into the gate; this repo is
already sensitive to gate contention (#3138, #2690).

## Layout

```
scripts/guards/
  manifest.ts       GuardEntry registry — REAL guards go here
  harness.ts        Engine: applyMutation, evaluateGuard (mutate → run → restore)
  run-guards.ts     `bun run guards` CLI entry point
  harness.spec.ts   Bypass-fixture self-test of the engine itself
  fixtures/         Self-contained reachable/dead guard pairs used only by harness.spec.ts
```

## Registering a guard

Add an entry to `guards` in `manifest.ts`:

```ts
{
  id: "my-guard",
  label: "short human description shown in the report",
  file: "packages/.../my-module.ts",       // repo-relative
  mutation: {
    find: /throw new MyGuardError\(.*\);/, // must match exactly once, no 'g' flag
    replace: "return;",                     // defeats the guard
  },
  concreteSpecs: ["packages/.../my-module.concrete.spec.ts"],
}
```

**`concreteSpecs` must use a real dependency, not a fake.** A hand-written
`fakeDb` / `mockExec` that can present states the real thing can't produce
will make this harness lie — it'll report REACHABLE because the fake is
wired up, exactly the failure mode #3212 exists to kill. If the only
existing coverage for a guard is fake-based (this is common — see
`branch-guard.spec.ts`), write a small companion spec against the real
dependency (see `branch-guard.concrete.spec.ts` for the pattern: a real
temp git repo, no mocks) and list *that* file, not the fake-based one.

A stale mutation regex (guard refactored, pattern no longer matches) fails
loudly with `MutationNotFoundError` rather than silently mutating nothing
and reporting a false "DEAD" — don't chase that as a real finding; fix the
regex.

## Why every guard needs a genuine bypass demonstration

`harness.spec.ts` doesn't just test a "happy path" guard — it also carries
a fixture (`fixtures/dead-guard/`) where the guard is present but
unreached, proving the harness actually reports DEAD when that's true. A
harness that could only ever say REACHABLE would be exactly as vacuous as
the guard-with-only-fake-coverage problem this issue exists to fix — a
check that always passes isn't a check. Follow the same discipline when
registering a real guard: if you can't point to (or write) a concrete spec
that would actually break without it, the guard shouldn't be listed yet.

## Output

```
REACHABLE      phase runsOn branch guard refuses a non-matching branch    3 pass     0 fail

checked 1 guard: 1 reachable, 0 dead, 0 error
```

A `*** DEAD ***` line means a guard survived its own deletion — CI-red, not
a discovery left for the next manual review. A `*** ERROR ***` line means
the spec run itself didn't produce a verdict (crash, timeout, wrong path) —
distinct from DEAD on purpose, so a broken harness invocation is never
misread as "guard confirmed unreachable."
