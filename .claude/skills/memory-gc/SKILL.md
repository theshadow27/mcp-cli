---
name: memory-gc
description: Audit and garbage-collect a committed Claude-memory store (MEMORY.md + per-fact files). Evidence-based, parallel, then a gated apply. Use when MEMORY.md has grown large, after several sprints, when memory has drifted from CLAUDE.md, or when the user says "/memory-gc", "clean up memory", "audit memory", "the memory is huge", or notices memory diffs/orphans.
---

# memory-gc — garbage-collect committed memory

On this project the "user-local" memory store is **committed to the repo** — it is shared team
context, not a private scratchpad. That means it rots like any doc: facts duplicate CLAUDE.md,
reference closed issues, describe subsystems that moved, or accrete sprint mechanics that belong in
the sprint skill. This skill audits every memory **with evidence**, then applies only the safe
changes.

Canonical store path (symlinked from `~/.claude/projects/<slug>/memory/`):
`<repo>/.claude/memory/` — `MEMORY.md` is the index (one line per memory); each line links a
per-fact `*.md` file. Some facts live **inline** in MEMORY.md with no backing file.

## Why a workflow (don't do this single-threaded)

The highest-value verdict — "this is OBE, delete it" — is also the easiest to get wrong by guessing.
Every memory that references an issue/PR/commit/flag must be **verified against live state** (`gh`,
`git`, codebase grep) before it can be called outdated. That is dozens of independent `gh` calls;
fan them out to one sonnet worker per memory so each gathers its own evidence in its own context.
The orchestrator only ever sees the conclusions.

## Method (4 steps)

### 1. Inventory + integrity (bidirectional)
```bash
cd <repo>/.claude/memory
# files not indexed in MEMORY.md (orphans):
for f in *.md; do [ "$f" = MEMORY.md ] && continue; grep -q "($f)" MEMORY.md || echo "ORPHAN: $f"; done
# index lines whose file is gone (broken links):
grep -oE '\]\([a-z0-9_-]+\.md\)' MEMORY.md | sed -E 's/\]\(|\)//g' | while read l; do [ -f "$l" ] || echo "MISSING: $l"; done
```
Also enumerate the **inline** facts (MEMORY.md lines with no link) — group them by section; they get
audited too. Enumerate the comparison targets that actually exist: the project `CLAUDE.md`, any
package/dir `CLAUDE.md` (`test/`, `packages/*/`), and the sprint skill (`SKILL.md` + `references/*`).
**Do not** compare against a *parent* repo's `CLAUDE.md` — that's a different repo's concern.

### 2. Classify (the workflow)
Run the bundled workflow, passing the file list and inline groups discovered in step 1:
```
Workflow({ scriptPath: "<repo>/.claude/skills/memory-gc/workflow.js",
           args: { repoRoot: "<absolute repo root, e.g. from `pwd`>",
                   files: [...], inlineGroups: [{section, lines:[...]}, ...] } })
```
Each worker reads its memory, finds its index line (or flags it an orphan), reads the relevant
comparison targets, **verifies every reference with `gh`/`git`**, applies the decision tree below,
and returns a structured verdict. A synthesis barrier then arbitrates cross-memory conflicts, guards
against move-bloat (many facts piling into one CLAUDE.md), and partitions into AUTO-SAFE /
NEEDS-REVIEW / KEEP with exact mechanical actions.

### 3. Decision tree (refined — emit all signals, one primary verdict + confidence)
1. **Duplicate of a CLAUDE.md / skill file?**
   - substantially same → **delete** (delete file *and* its index line together)
   - **contradicts** the target → **flag** (humans reconcile; never auto)
   - memory is materially better/more complete → **merge-into-claudemd** (don't just delete the better copy)
2. **Intentional pointer/stub** (body says "canonical X lives at `<repo path>`")? → **keep**. A redirect
   looks like a duplicate but is load-bearing — never delete it as a dup.
3. **References an event/issue/PR/commit/sprint?**
   - verified outdated/wrong/OBE (closed/merged **and** the behavior it guides is now impossible) → **delete**
   - current, tracked by an open backlog issue, **and** no operational impact on running a sprint → **delete** (issue carries it)
   - current **with** operational impact → keep going
4. **Concerns a specific subsystem/package?**
   - already covered by that package's `CLAUDE.md` → **delete**
   - belongs in a package `CLAUDE.md` → **move-package-claudemd**
   - changes behavior outside the subsystem / sprint-wide → **flag**
5. **Concerns sprint mechanics/lifecycle?** → **move-sprint-skill**
6. Otherwise → **keep**.

**Operational-impact test** (the keep/delete pivot): a memory has operational impact iff an
orchestrator acting on it *today* would behave differently **and** the behavior is still possible.
If the thing it warns against is now impossible (flag removed, tool replaced, code path gone), it is
OBE **even if its issue is still open**.

**Bias:** default to `flag`/`keep` under uncertainty. `delete` requires hard, cited evidence. Git
makes deletes recoverable, but wrongly deleting load-bearing orchestration guidance = a future
sprint failure.

### 4. Apply (gated — "safe ops only")
Workers **never write** — meta-files (`.claude/memory/**`, `CLAUDE.md`, `skills/**`) are
orchestrator-only. After reviewing the synthesis report, the orchestrator applies directly:
- **Auto-apply** only: non-destructive index fixes (add orphan line, repair stale link) and
  high-confidence, evidence-backed deletes. When deleting a file, delete its MEMORY.md line in the
  same edit so no broken link is created.
- **Hold for the user**: every move/merge, every `flag`, and every medium/low-confidence delete.
- Commit the memory changes on `main` (memory is meta — orchestrator/retro territory, not a worker
  branch). Summarize counts: deleted N, fixed M index lines, K flagged for review.

## Notes
- Tune worker count to store size; one worker per file scales fine to ~100 memories.
- The workflow is read-only; re-run freely. Use `resumeFromRunId` to iterate the script cheaply.
- If `gh` is unauthenticated in the worker context, the worker says so in `evidence` and downgrades
  confidence — it must not fabricate an issue state.
