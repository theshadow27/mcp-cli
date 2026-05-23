# Sprint 61

> Planned 2026-05-23 18:40 EDT. Started 2026-05-23 18:42 EDT. Target: 15 PRs.

## Goal

Harden the fast-import / git-remote-mcx clone arc (epic #1209) — land the
parser, writer, and export bug fixes now that the real import handler (#1211)
has shipped, so the export/push path is correct end-to-end.

## Issues

| # | Title | Scrutiny | Batch | Model | Category |
|---|-------|----------|-------|-------|----------|
| 1311 | protocol: don't write `done\n` on import error path | low | 1 | opus | goal |
| 1280 | parser: unterminated `data <<DELIM` here-doc throws | low | 1 | opus | goal |
| 1277 | writer: `FastImportEntry.content` accept binary blobs | medium | 1 | opus | goal |
| 1312 | export: partial-failure transactional semantics | high | 1 | opus | goal |
| 2229 | agent-tools: generalize `art` helper to default descriptions | low | 1 | sonnet | filler |
| 1279 | parser: encoding header causes empty message + desync | low | 2 | opus | goal |
| 1263 | writer: parseMarksFile regex rejects SHA-256 repos | low | 2 | opus | goal |
| 1281 | export: route ParsedCommit → provider push/create/delete | high | 2 | opus | goal |
| 1323 | protocol: safe truncation (pair of #1311) | low | 2 | sonnet | goal |
| 1365 | worktree-shim: core.bare before/after prune probes | low | 2 | opus | filler |
| 2228 | test(clone): git-init sanity-check error path | low | 3 | sonnet | filler |
| 1313 | phases: wire parseSource into `mcx phase install` | low-medium | 3 | opus | filler |
| 1244 | trace: daemon-side ipc-server operation spans | low | 3 | sonnet | filler |
| 1262 | writer: incremental-add API (no deleteall full-tree) | medium | 3 | opus | goal |
| 2208 | CI: setup-bun@v2 401 flake — pin/retry | low | 3 | sonnet | filler |

## Batch Plan

### Batch 1 (immediate)
#1311, #1280, #1277, #1312, #2229

### Batch 2 (backfill)
#1279, #1263, #1281, #1323, #1365

### Batch 3 (backfill)
#2228, #1313, #1244, #1262, #2208

### Dependency edges (→ addBlockedBy at run)
- #1279 blockedBy #1280 (shared fast-import-parser.ts — serialize parser edits)
- #1263 blockedBy #1277 (shared fast-import-writer.ts)
- #1262 blockedBy #1263 (shared fast-import-writer.ts — writer edit chain)
- #1281 blockedBy #1312 (export handler consumes the partial-failure txn design)
- #1323 blockedBy #1311 (same remote-protocol.ts error path — near-duplicate;
  the #1323 session MUST rebase on merged #1311 and close-as-done if redundant)

### Hot-shared files (serialization enforced via the edges above)
- `fast-import-parser.ts`: #1280 → #1279
- `fast-import-writer.ts`: #1277 → #1263 → #1262
- `remote-protocol.ts`: #1311 → #1323

## Context

Epic #1209 (git-remote-mcx) had its import handler (#1211) and writer/parser
foundations (#1257, #1273) land in prior sprints; this sprint clears the
correctness backlog those reviews surfaced — parser error cases, binary-blob
support, marks-file SHA-256, and the export/push handler with transactional
semantics. Fillers are independent quick wins (CI flake #2208, art helper
#2229, trace spans #1244, worktree-shim instrumentation #1365, phase-install
wiring #1313, clone test #2228). Excluded: #2186 (meta — modifies a phase
file, deferred to meta flow), #2210/#2215 (flaky/upstream, need repro),
#2074 (needs-clarification), monitor (#1924/#1939) and sites (#1595/#1459)
epics deferred to dedicated sprints.
