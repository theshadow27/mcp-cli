# Epic: Agent Provider Protocol & Grid

## North Star

mcx talks to ≥6 agent providers today (claude, codex, opencode, acp, gemini, copilot, grok, mock). Only claude is exercised regularly, and only at one pinned version. Codex is fully broken (#2482) and nobody noticed for two sprints. We are flying blind on every non-claude provider.

**The north star:** a versioned, recorded, machine-checkable protocol between mcx and any agent worker, with a continuously-maintained matrix of `(provider × version)` test outcomes recorded in-repo, a nightly pipeline that adds new versions and retests known-failing ones, and a mock provider that is the canonical reference implementation. When a provider breaks, an issue exists within 24 hours, tagged by failure class and version. The one current dependency we cannot afford to lose — claude 2.1.119, which auto-sprint pins to — is manually archived in LFS so anthropic yanking it from npm cannot brick the auto-sprint.

## Components

### 1. Formal protocol spec (`docs/agent-protocol.md`)
Single document, single source of truth, names every message type that crosses the worker↔daemon boundary:

- **Control messages** (parent → worker): `init`, `tools_changed`, `restore_sessions`
- **Init handshake** (worker → parent): `ready`, including `protocol_version: N`
- **DB event messages** (worker → parent): `db:upsert`, `db:state`, `db:cost`, `db:disconnected`, `db:end`, `metrics:inc`, `metrics:observe`
- **MCP JSON-RPC** (bidirectional, tunnelled via `WorkerTransport`)
- **Session events** (worker → parent → consumers): `AgentSessionEvent` union — init, response, permission_request, result, error, disconnected, ended

For each: payload schema (Zod), required vs optional fields, capability gates (`requires: costTracking`), back-compat rules (additive only within a major version), examples.

The spec is **versioned**. Bumping the version is a deliberate act, captured in the spec changelog.

### 2. Protocol version negotiation
`InitMessage` carries `protocol_version: N`. Worker's `ready` message echoes the version it supports. If they don't match: daemon fails the spawn loudly with a typed error pointing at this doc, *not* a generic RPC -32600 ten layers deep. (This is the real fix for what happened to codex.)

### 3. `AgentFeatures` as the capability contract
Already exists in `packages/core/src/agent-provider.ts`. Three changes:

- **Treat the declaration as a claim, not a config.** The nightly grid verifies that what a provider declares it can do, it actually does. Lying = failing test.
- **Add the protocol-side features that are currently implicit**: `permissionRoundtrip`, `multiTurn`, `interruptAck`, `toolCallReporting`. Mock declares all; others declare what they actually do.
- **Capability discovery CLI**: `mcx agent <provider> capabilities` dumps the negotiated set. File as standalone story; doesn't block the epic.

Runtime tool capabilities (file I/O, bash, webfetch) stay out of the registry — they're per-spawn negotiation, not provider-static. The test suite handles that via capability-gated skips.

### 4. Versions grid (`agent-grid/versions.yaml`)
Committed to main. Schema:

```yaml
providers:
  - name: claude
    track: patch         # detect new patches automatically; minor/major needs human PR
    versions:
      - version: 2.1.119
        first_seen: 2026-05-23T21:24:15Z
        last_tested: 2026-05-28T03:00:00Z
        outcome: pass
        recording: recordings/claude-2.1.119.ndjson
        archive: binaries/claude-2.1.119.tgz  # LFS pointer, manual one-off (auto-sprint dep)
      - version: 2.3.131
        first_seen: 2026-05-25T03:00:00Z
        last_tested: 2026-05-25T03:00:00Z
        outcome: fail
        failure_class: runtime-broken
        issue: 2599
  - name: codex
    track: patch
    versions:
      - version: 0.30.1
        outcome: fail-wontfix
        reason: "Codex 0.x lacks resume; tracked in #2482"
        last_tested: 2026-05-20T03:00:00Z
  - name: grok
    track: minor
    enabled: false       # stubbed
```

Outcomes: `untested | pass | fail | fail-wontfix | flake`. Only `untested` and `fail` are eligible for retest; `fail-wontfix` is re-tested only when the version changes.

`enabled: false` is how grok/copilot/gemini stay stubbed without removing them.

### 5. Pipeline (4 distinct steps)

```
(i) detect-latest  → (ii) update-grid → (iii) run-matrix → (iv) aggregate
```

**(i) detect-latest** (`bun scripts/agent-grid-detect.ts`)
For each enabled provider, query registry (`npm view <pkg> version`, `pip show`, GH release, etc.) for the latest version on the configured `track`. Output: list of new `(provider, version)` pairs.

**(ii) update-grid**
Append new rows to `versions.yaml` as `outcome: untested`. Open a PR (not direct push to main — the grid is reviewed). PR body lists the new versions and any concurrent registry yanks (versions that disappeared since last run).

**(iii) run-matrix**
Read `versions.yaml`, select rows where `outcome in {untested, fail}` AND `enabled != false`. One matrix leg per row. Each leg:
1. Install pinned version (registry → fallback to LFS archive if one exists for that version)
2. Run capability suite in isolated tmpdir
3. Record full protocol exchange to `recordings/<provider>-<version>.ndjson`
4. Run recording through PII/secret sanitizer before persisting
5. Write outcome + recording path back into a per-leg artifact

**(iv) aggregate** (runs `if: always()`, depends on all matrix legs)
- Merge per-leg artifacts into `versions.yaml`
- Classify failures
- File/update/close issues
- Open a PR committing the updated grid + sanitized recordings

LFS-archiving a binary is **never** automatic — it's a deliberate manual step (see §8) reserved for versions we cannot afford to lose access to (today: just claude 2.1.119).

### 6. Recording pipeline
Wire into `worker-transport.ts` and the daemon's IPC layer. When recording is on (`MCX_RECORD_SESSION=<path>` or `mcx agent <provider> record --save=<path>`), capture every message in both directions, plus DB events, as NDJSON:

```jsonl
{"t":1748432655.123,"dir":"daemon->worker","kind":"control","payload":{"type":"init","daemon_id":"..."}}
{"t":1748432655.234,"dir":"worker->daemon","kind":"control","payload":{"type":"ready","protocol_version":1}}
{"t":1748432655.345,"dir":"daemon->worker","kind":"mcp","payload":{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{...}}}
{"t":1748432656.012,"dir":"worker->daemon","kind":"db","payload":{"type":"db:cost","session_id":"...","usd":0.0012}}
```

Uses:
- **Diagnostics**: paste recording into a bug report, replay locally
- **Capability inference**: scan recordings to see what providers actually emit; if everyone emits `db:cost` but only claude declares `costTracking: true`, that's a flag
- **Mock fixture generation**: convert recording → mock script for a future regression test
- **Compliance check**: assert that what a provider sent matches the protocol spec

Sensitive content: recordings committed to the public repo come **only** from synthetic fixture prompts (no real user data), **and** are run through a PII/secret sanitizer before commit. Sanitizer responsibilities:
- Strip env vars, headers, and JSON fields matching known secret patterns (`*_KEY`, `*_TOKEN`, `Authorization: *`, JWTs, AWS access keys, etc.)
- Replace absolute home paths (`/Users/<name>/…`) with `${HOME}` placeholders
- Redact email addresses, IPs, and free-text fields that match common PII regexes
- Run as a library (callable from local runner + CI) and as a pre-commit hook for the `recordings/` and `binaries/` paths
- Fail loud if a pattern matches *after* sanitization (defense in depth — caller can override with `--allow-unsanitized`, which the CI workflow never sets)

Local recordings stay under `~/.mcp-cli/recordings/` and are git-ignored; only sanitized fixtures cross into the repo.

### 7. Mock as canonical reference
Today claude is canonical-by-accident. Make it explicit:

- Mock's protocol surface must be a **superset** of every real provider's surface
- Mock's `AgentFeatures` declaration is `all: true`
- Mock-script DSL grows beyond today's `[{delay, text}]`:
  ```json
  [
    {"emit": "init", "session_id": "..."},
    {"emit": "response", "text": "..."},
    {"emit": "tool_call", "name": "Read", "args": {...}},
    {"emit": "permission_request", "tool": "Write", "args": {...}},
    {"wait_for": "approve"},
    {"emit": "cost", "usd": 0.001},
    {"emit": "result", "text": "done"},
    {"emit": "end"}
  ]
  ```
- Rule: a new protocol feature lands in mock + mock script DSL **first**, with a failing test that real providers must catch up to

This also enables replay-from-recording: feed `recordings/claude-2.1.119.ndjson` to mock, get bit-exact reproduction.

### 8. Binary archive (Git LFS — manual, narrow scope)
`agent-grid/binaries/`, LFS-tracked. Stores npm tarballs (5-20 MB compressed), **not** the unpacked SEA. Lockfile: sha256 + size per (provider, version).

**Default behaviour: nothing is archived.** `scripts/install-agent.ts` pulls from the registry. The LFS fallback exists for one specific case: a version we cannot afford to lose access to.

**Initial archive: claude 2.1.119, manually committed.** This is the version auto-sprint pins to (see `claudeBinary` config), and the user's local copy is the only known good copy left if anthropic yanks it. One-off PR to add it; done.

Future archive additions are a deliberate human decision per PR — typical trigger: "we just pinned auto-sprint to provider X version Y; archive Y so we keep the dep stable even if upstream rolls it back". No automation, no 3-pass-rule, no batch promotion. The grid runs over the registry's current copy of each version unless an archive exists, in which case `install-agent.ts` prefers the archive (deterministic).

Storage budget: a handful of MB, indefinitely. Stays well below any LFS quota concern.

### 9. Capability test suite (`agent-grid/`)
New package. Each test:
- Declares required capabilities (`requires: ["worktree", "fileWrite"]`)
- Runs in an isolated tmpdir, git-initialized from a fixed seed commit
- Spawns in `dangerouslySkipPermissions` (or each provider's equivalent baseline)
- Records the protocol exchange
- Asserts on outcome + emitted events (cost reported, state transitions, etc.)
- Skip-with-reason when capability missing (recorded as `n/a`, not pass/fail)

Initial set:
1. `spawn-in-dir` — spawns in tmpdir, reports cwd back
2. `read-file` — reads a known file, returns content
3. `edit-file` — edits a file, diff verified
4. `fix-typescript` — fix one missing `;` in a `.ts` file, verify it compiles
5. `run-bash` — execute `pwd`, verify output
6. `multi-turn` — three-turn conversation, verify context retained
7. `interrupt-and-recover` — start long task, interrupt, verify clean state
8. `report-cost` — verify `db:cost` is emitted with non-zero value (skipped if `costTracking: false`)
9. `permission-baseline` — request a sensitive op, verify the permission round-trip happens (skipped if `permissionRoundtrip: false`)
10. `resume-session` — spawn, save sessionId, bye, resume, verify history (skipped if `resume: false`)

Permission-model unification (claude's fine-grained model applied across providers) is **out of scope** for this epic and filed separately. Baseline permission test only verifies that *something* is happening when a sensitive op is requested.

### 10. Aggregator + issue lifecycle
Failure classes:
- `spawn-failed` — binary won't launch (codex #2482 pattern)
- `protocol-broken` — RPC mismatch, version negotiation fail, malformed message
- `runtime-broken` — spawned OK but failed a capability test
- `flake` — failed once, passed on rerun within the same run
- `quota` — out of credits / auth invalid (not a code bug; pings owner, doesn't open issue)
- `wontfix` — known regression, recorded in grid, no issue churn

Issue lifecycle:
- Title: `nightly: <provider>@<version> — <failure-class>`
- Labels: `nightly-grid`, `agent:<provider>`, `<failure-class>`
- On failure with no matching open issue: open one with recording attached + minimal repro command
- On failure with matching open issue: comment with new run's recording + timestamp
- On pass for previously-failing version, ≥3 consecutive nights: comment "PASSING since N — auto-closing" and close
- On stale issue (30 days no activity, version no longer tested): label `stale`, ping `@team`

Aggregator must run `if: always()` so a crashed leg doesn't suppress reporting of other legs. Aggregator does NOT short-circuit on its own errors — partial reporting is better than no reporting.

### 11. Local runner
`mcx agent-grid run [--providers=X,Y] [--version=2.1.119] [--offline] [--record=path]`
- Runs same suite CI does, on the developer's machine
- `--offline`: install from LFS archive only, fail if not cached
- `--record`: save recording to path (default: tmp)
- Same exit codes as CI; classify failures the same way
- Doesn't write to `versions.yaml` (read-only by default; `--commit-outcome` opt-in for ops use)

Critical for the workflow "codex looks broken, let me reproduce" → run `mcx agent-grid run --providers=codex` and you have the recording in 30 seconds.

### 12. CLI surfaces (independent stories, can land separately)
- `mcx agent <provider> capabilities` — print declared + negotiated capabilities
- `mcx agent <provider> record --save=<path>` — capture this session's protocol exchange
- `mcx agent-grid status` — print latest `versions.yaml` summary, last-run times, outstanding issues
- `mcx agent-grid replay <recording>` — replay a recording against mock, verify it conforms to spec

### 13. mcpctl
Add to session list / detail view:
- Provider name
- Declared `AgentFeatures`
- Negotiated `protocol_version`
- Recording status (on/off, file path if on)
- Failure-class flag if session ended in error

### 14. Compatibility matrix doc (auto-generated)
`agent-grid/README.md` is generated by a script from `versions.yaml` + `AgentFeatures` declarations. Rows = providers, columns = features + capability tests. Cells = ✓ / ✗ / shimmed / n/a, with links to recordings.

Generator runs as part of step (iv); commits a fresh README alongside the grid update. Keeps the formal spec at `docs/agent-protocol.md` clean (last-modified is meaningful, not churn from grid updates).

## Story Breakdown (3-4 sprints)

### Sprint A — Foundation
1. `docs/agent-protocol.md` — formal spec, every message type, versioned, with mock as reference
2. Protocol version negotiation — `protocol_version` in `InitMessage`, typed hard-fail on mismatch (fixes codex #2482 class of bugs)
3. Mock-script DSL extension — permission, tool_call, cost, error, interrupt, multi-turn, wait_for-approve
4. Recording infrastructure — instrument `worker-transport.ts` + IPC layer, NDJSON output, env-gated by default
5. Audit & migrate internal tests from real claude to mock (replace any spec that spawns claude binary)

### Sprint B — Grid + binary management
6. `agent-grid/versions.yaml` schema + Zod validator + CI check
7. `scripts/install-agent.ts` — registry-first, LFS-fallback, sha256-verified
8. Git LFS enablement for `agent-grid/binaries/` + manual commit of `claude-2.1.119.tgz` (one-off; archives are explicit per-PR going forward)
9. PII/secret sanitizer library + pre-commit hook for `recordings/`
10. `scripts/agent-grid-detect.ts` — detect new versions per track
11. Local runner skeleton — `mcx agent-grid run`, single-leg first
12. Isolation framework — tmpdir + git-init per test, cleanup-on-failure

### Sprint C — Test suite + replay
12. `agent-grid/` package scaffold + capability gating + skip-with-reason
13. First 5 capability tests (spawn-in-dir, read-file, edit-file, run-bash, multi-turn)
14. Recording-replay against mock (`mcx agent-grid replay`)
15. Remaining capability tests (interrupt-and-recover, fix-typescript, report-cost, permission-baseline, resume-session)
16. `AgentFeatures` expansion (add `permissionRoundtrip`, `multiTurn`, `interruptAck`, `toolCallReporting`), declarations verified by suite

### Sprint D — CI pipeline + ops surface
17. `.github/workflows/agent-grid.yml` — 4-stage pipeline (detect → grid-update → matrix → aggregate)
18. Per-leg budget caps, timeouts, secrets management (ANTHROPIC, OPENAI, XAI, GEMINI, GITHUB_TOKEN), runbook for key rotation
19. Aggregator script — classify, file/update/close issues, write grid outcomes, attach sanitized recordings
20. Compatibility matrix README generator
21. mcpctl protocol-version + capability display
22. `mcx agent <provider> capabilities` CLI

### Stretch / parallel
- `mcx agent-grid status` CLI
- `mcx agent <provider> record` CLI flag (one-off recording from a normal spawn)
- Failure-class metrics (`agent.spawn.failure{provider, class}`) exposed via `mcx serve --stats`

### Out of scope (file separately)
- **Unify coarse-grain baseline sandbox permissions** — apply a claude-style permission router across providers. Heavy lift; deserves its own epic.
- **Remote-agent providers** — claude-in-docker, claude.ai, bedrock. Capability framework should accommodate, but no implementations in this epic.
- **Auto-sprint version pinning via grid** — auto-sprint reads from `versions.yaml` which version of each provider to use, with override. Separate epic; depends on this one.

## Risks & mitigations
- **LFS bandwidth quota**: minimal — archives are manual and rare (initially just claude 2.1.119)
- **Provider API key rotation across 5+ secrets**: document the rotation runbook in `agent-grid/SECRETS.md`; quarterly review
- **`fail-wontfix` as a "shut it up" escape hatch**: require the wontfix row to have a `reason:` and a linked issue, enforced by the schema validator
- **Recording leaks (PII or secrets in committed recordings)**: synthetic-only test prompts + sanitizer library run on every recording before commit + pre-commit hook + CI re-check. Defense in depth; sanitizer is a story in its own right (Sprint B)
- **Codex/other providers stay broken indefinitely**: that's a feature, not a bug — the grid shows the truth. Fixing them is separate work.

