# Investigations: nerd-snipe gate before impl

Some issues need root-cause work BEFORE a fix can land. Flaky tests are
the canonical case (sprint 15-19, 47, 50, 51, 52 all hit the "fix →
re-break" pattern when implementations skipped root-cause), but the
pattern generalizes to:

- **Flaky tests / CI instability** (`label:flaky`, or a closed bug
  re-opening with the same symptom)
- **Deterministic failures with unclear mechanism** (the test fails
  every run but no one knows why)
- **Recurring bugs** that have already been "fixed" once and came back
- **Perf regressions** without an obvious patch
- **Security findings** where the wrong fix can mask the underlying
  exposure

The orchestrator's job for these is to gate implementation behind a
documented investigation. This file is the canonical reference; both
`plan.md` (when classifying picks) and `run.md` (when spawning) point
here.

## When to apply

Add the investigation gate when ANY of these is true for the issue:

- Title or label contains "flaky" or `flaky`
- Issue body cites a CI failure that the reporter cannot reproduce locally
- A previous closure for the same root symptom exists (grep
  `gh issue list --state closed --search "<test-name>"`)
- The repro is non-deterministic, environment-sensitive, or
  intermittent
- The reporter explicitly asks for an investigation before a fix

If none of these are true, run the issue through the normal impl phase.
The gate is for issues where the wrong fix is worse than no fix.

## The gate

1. **Spawn a nerd-snipe worker** (see "Spawn shape" below).
2. **Worker posts findings as a GitHub issue comment.** Timeline,
   bisect log, mechanism, concrete fix plan. The trail being on the
   issue — not in an ephemeral session transcript — is what stops the
   next sprint from re-running the same misdiagnosis.
3. **Hard gate**: if the worker cannot produce both root cause AND a
   concrete fix plan, the issue does NOT proceed to implementation.
   Apply `needs-attention` and stop. Surface in retro. **Do not let an
   unresolved investigation slide into "spawn opus impl and hope"** —
   that is the failure mode this rule prevents (sprint 47 / #1870
   incident).
4. **Then implement on opus** (never sonnet) using the issue comment
   as the spec.
5. **Always adversarial review** for the impl PR. The reviewer's job
   is to verify the implementation matches the documented mechanism —
   not just that "tests pass now." Reject fixes that increase
   timeouts, add retries, or otherwise mask the symptom without
   addressing the mechanism in the writeup.

## Spawn shape (load-bearing — see #2009)

**Use `mcx claude spawn`, NOT the Agent tool / `subagent_type: "nerd-snipe"`.**

```bash
mcx claude spawn --worktree --model opus -t "$(cat <<'PROMPT'
You are nerd-snipe (read .claude/agents/nerd-snipe.md directly first to
ground in the persona — do NOT invoke the Agent tool yourself).

Your job is to investigate GitHub issue #<n>: <one-line repro>.

Existing context:
- Bisect range: <commit-range>
- Prior diagnoses (must rule out or confirm): <links>
- Existing needs-attention trail (if any): <link>

Verify or reject each suspected mechanism in order. Post findings as a
GitHub issue comment with:
  - Timeline of what was investigated
  - Bisect log
  - Confirmed mechanism (or "no root cause found, here is what was
    ruled out")
  - Concrete fix plan (or "no concrete fix yet — recommend
    needs-attention")

If you cannot produce both root cause AND a concrete fix plan, post
the partial trail and stop. Do not propose a speculative patch.
PROMPT
)"
```

**Why `mcx claude spawn` and not the Agent tool**: the Agent tool
spawns a sub-context inside the orchestrator's session. Background
Agent calls give the parent **no progress visibility** — sub-agent
tool_use events go to a separate JSONL under `subagents/`, not
streamed back. Sprint 52 routed both #1980 and #1987 to
`needs-attention` with "watchdog killed at ~10 min" comments;
investigation in #2009 showed the sub-agents had actually run for 28
minutes of active reasoning and were 1–2 turns from a verdict when
the orchestrator's poll-and-give-up cut them off.

mcx-spawned workers stream tool_use events natively. `mcx claude wait
<session>` and `mcx claude log <session>` give genuine progress
signal. Nerd-snipe can run for an hour; that is fine. The "session
looks idle" framing was an Agent-tool artifact.

The "do NOT invoke the Agent tool yourself" line in the prompt is
critical. Without it, nerd-snipe will helpfully
`Agent({subagent_type: "nerd-snipe"})` recursively and re-create the
same sub-context invisibility.

## Tracking the worker

Once spawned:

```bash
# wait for it to finish (event-driven, not blind polling)
mcx claude wait <session-id>

# read the final transcript
mcx claude log <session-id> --tail 200

# or stream events live
mcx monitor --src <session-id> --json --type session.text
```

The orchestrator reads the issue comment after the worker exits.
Trust the comment, not the session transcript — the comment is the
durable record.

## After the gate

| Outcome | Action |
|---------|--------|
| Root cause + fix plan in comment | `phase=impl` on opus |
| Partial findings, no concrete fix | apply `needs-attention`, surface in retro |
| Already-fixed by a prior PR | close issue with a link |
| Repro reveals a different bug | file new issue, close original as duplicate-of-new |

## Why this lives in references/, not in MEMORY

User-level memory (`~/.claude/projects/.../memory/`) is per-user and
not committed. Load-bearing sprint rules — the ones the orchestrator
needs every time — must live in the repo so every Claude session
working on this project sees the same rule. Memory entries can
re-state or summarize repo-level rules but cannot be the source of
truth for them.

## See also

- `plan.md` — apply the gate at issue classification time
- `run.md` — invoke the gate when impl phase fires for a flagged issue
- `references/mcx-claude.md` — `mcx claude spawn` / `wait` / `log` details
- Issue #2009 — the spawn-shape decision
- `.claude/diary/20260504.52.md` — the sprint-52 incident that drove the correction
