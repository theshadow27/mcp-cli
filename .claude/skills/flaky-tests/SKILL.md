---
name: flaky-tests
description: >
  Mine flaky test failures from Claude Code session transcripts. Scans JSONL
  session files for test failure patterns in tool results, aggregates by test
  file and name, and reports which tests fail across multiple sessions. Use
  when investigating test reliability, after a sprint to check for new flaky
  tests, or when the user says "flaky tests", "which tests are flaky",
  "test stability report", or "/flaky-tests".
---

# Flaky Test Mining

Scan session transcripts to identify tests that fail across multiple sessions —
the signature of true flakiness vs one-time breakage.

## How it works

```bash
bun run .claude/skills/flaky-tests/mine-flaky-tests.ts --since 2026-03-10
```

**Always pass `--since`** with a recent date (e.g. the start of the last sprint) to
avoid counting failures from before known fixes landed. Without it, the script
scans every session file ever created and will report stale hits.

The script:
1. Reads JSONL session files for the current project (filtered by `--since` if given)
2. Extracts tool result content (Bash output from test runs)
3. Matches bun test failure patterns (`✗`, `FAIL`, `expect(...).toEqual` mismatches)
4. Extracts test file name and test description from failure context
5. Groups by (file, test) and counts distinct sessions
6. Reports sorted by session count — tests appearing in 2+ sessions are truly flaky

## Interpreting results

- **3+ sessions**: High-confidence flaky. File an issue immediately.
- **2 sessions**: Likely flaky. Worth investigating — could be a real regression that
  got fixed, or a timing-dependent test.
- **1 session, multiple occurrences**: Suggests retry loops hit the same failure.
  May indicate a module-level setup problem rather than test-level flakiness.

## After running

1. Compare results against existing flaky test issues (`gh issue list --label bug --search "flaky"`)
2. File new issues for any newly discovered flaky tests with reproduction data
3. Note patterns: are flaky tests concentrated in one file? One subsystem?
   Filesystem watchers and timing assertions are the usual suspects.
