export const meta = {
  name: 'memory-gc',
  description: 'Audit committed Claude memory: evidence-based per-memory classification + synthesis',
  phases: [
    { title: 'Classify', detail: 'one sonnet worker per memory file + per inline-fact group', model: 'sonnet' },
    { title: 'Synthesize', detail: 'arbitrate conflicts, dedup moves, build ranked action report' },
  ],
}

// ---- Inputs -----------------------------------------------------------------
const ARGS = typeof args === 'string' ? JSON.parse(args) : args || {}
const REPO = ARGS.repoRoot
const MEMDIR = `${REPO}/.claude/memory`
const FILES = Array.isArray(ARGS.files) ? ARGS.files : []
const INLINE_GROUPS = Array.isArray(ARGS.inlineGroups) ? ARGS.inlineGroups : []

if (!REPO) throw new Error('args.repoRoot (absolute repo root path) is required')
if (!FILES.length) throw new Error('args.files (array of memory filenames) is required')

// ---- Shared context handed to every classifier -----------------------------
const CONTEXT = `
You are auditing ONE unit of a Claude Code "user-local memory" store that — on THIS project — is
COMMITTED TO THE REPO. The store lives at ${MEMDIR}/ . MEMORY.md is the index (one line per memory).

Repo root: ${REPO}
Comparison targets you may read to decide overlap:
  - ${REPO}/CLAUDE.md                                   (project instructions — the main dup target)
  - ${REPO}/test/CLAUDE.md
  - ${REPO}/packages/permissions/CLAUDE.md
  - ${REPO}/packages/daemon/src/mock-session/CLAUDE.md
  - ${REPO}/.claude/skills/sprint/SKILL.md  and  .claude/skills/sprint/references/*.md
Do NOT compare against ~/github/CLAUDE.md (that is GBG-platform, a different repo's concern).

EVIDENCE IS MANDATORY. Whenever the unit references an issue/PR (#NNNN), a sprint number, a commit,
a flag, or a tool/command, you MUST verify state before judging — do not guess:
  - gh issue view NNNN --repo <owner>/<repo> --json number,state,title,closedAt   (run \`gh repo view --json nameWithOwner\` once to get the slug)
  - gh pr view NNNN --json number,state,merged,mergedAt
  - git -C ${REPO} log --oneline -n 3 -S '<symbol-or-flag>' -- <path>   (does the code/flag still exist?)
  - grep the codebase for a flag/command the memory names, to confirm it still exists.
Put what you actually ran and what it returned in "evidence". An unverified OBE claim is invalid.

DECISION TREE (refined). Emit ALL matching signals, then ONE primary verdict + confidence.
  1. Duplicate of a CLAUDE.md / skill file?
       - substantially same content  -> verdict "delete" (and note the line must go too)
       - CONTRADICTS the target        -> verdict "flag" (humans must reconcile; never auto)
       - memory is materially better/more complete -> verdict "merge-into-claudemd" (target=which file)
  2. Intentional POINTER/STUB (body says "canonical X lives at <repo path>")?
       - load-bearing redirect -> verdict "keep" (signal "pointer-stub"); NEVER delete as a dup.
  3. References an event/issue/PR/commit/sprint?
       - verified outdated / wrong / OBE (closed/merged AND the behavior it guides is now impossible)
            -> verdict "delete"
       - current, tracked by an OPEN backlog issue, AND no operational impact on running a sprint
            -> verdict "delete" (the issue carries it; memory is redundant)
       - current WITH operational impact -> continue (likely "keep")
  4. Concerns a specific subsystem/package?
       - already covered by that package's CLAUDE.md -> verdict "delete"
       - belongs in a package CLAUDE.md -> verdict "move-package-claudemd" (target=path)
       - subsystem fact that changes behavior OUTSIDE that subsystem / sprint-wide -> verdict "flag"
  5. Concerns sprint mechanics/lifecycle? -> verdict "move-sprint-skill" (target=which sprint file)
  6. Otherwise -> verdict "keep".

OPERATIONAL-IMPACT TEST (the keep/delete pivot, apply literally):
  A memory has operational impact iff an orchestrator acting on it TODAY would behave differently,
  AND the behavior it guides is still possible. If the thing it warns against is now impossible
  (flag removed, tool replaced, code path gone), it is OBE even if its issue is still open.

BIAS: default to "flag" or "keep" under any uncertainty. "delete" requires hard, cited evidence.
Moves and merges are META-FILE edits — recommend only; they are NEVER auto-applied.

safe_auto rules (be strict):
  - true ONLY for: verdict "fix-index" (add a missing index line — non-destructive), OR
    verdict "delete" with confidence "high" AND evidence proving OBE/redundancy.
  - false for every move/merge/flag/keep and every medium/low-confidence delete.
`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['unit', 'kind', 'signals', 'evidence', 'verdict', 'confidence', 'safe_auto', 'rationale', 'index_action'],
  properties: {
    unit: { type: 'string', description: 'filename, or inline:<section> for inline groups' },
    kind: { type: 'string', enum: ['file', 'inline'] },
    indexed: { type: 'boolean', description: 'file has a line in MEMORY.md (false=orphan)' },
    signals: { type: 'array', items: { type: 'string' } },
    referenced_issues: { type: 'array', items: { type: 'string' }, description: 'e.g. ["#2597 CLOSED","#2577 OPEN"]' },
    evidence: { type: 'string', description: 'commands actually run + what they returned' },
    verdict: { type: 'string', enum: ['keep', 'delete', 'flag', 'move-claudemd', 'merge-into-claudemd', 'move-package-claudemd', 'move-sprint-skill', 'fix-index'] },
    target: { type: 'string', description: 'destination path for move/merge, else ""' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    safe_auto: { type: 'boolean' },
    rationale: { type: 'string' },
    index_action: { type: 'string', description: 'what to do to the MEMORY.md line: keep | delete-line | add-line:<text> | edit-line:<text>' },
  },
}

// ---- Phase 1: classify every file + inline group in parallel ----------------
const fileThunks = FILES.map((f) => () =>
  agent(
    `${CONTEXT}\n\nYOUR UNIT is the memory FILE: ${MEMDIR}/${f}\n` +
      `Steps: (1) Read the file. (2) Read MEMORY.md and find this file's index line; if absent it is an ORPHAN ` +
      `(set indexed=false, and if the memory is worth keeping the verdict for the index is "fix-index" with index_action add-line). ` +
      `(3) Read the relevant comparison targets. (4) Gather gh/git evidence for every reference. (5) Apply the tree. ` +
      `Return the verdict object for unit="${f}", kind="file".`,
    { label: `classify:${f}`, phase: 'Classify', model: 'sonnet', schema: SCHEMA },
  ).then((v) => (v ? { ...v, unit: v.unit || f, kind: 'file' } : null)),
)

const inlineThunks = INLINE_GROUPS.map((g) => () =>
  agent(
    `${CONTEXT}\n\nYOUR UNIT is a GROUP of INLINE MEMORY.md facts that have NO backing file — they live only in the index.\n` +
      `Section: "${g.section}". The lines:\n${g.lines.map((l, i) => `  ${i + 1}. ${l}`).join('\n')}\n\n` +
      `Evaluate EACH line with the tree (gather evidence for any reference). Because these have no file, ` +
      `"delete" means removing the line from MEMORY.md; a move means relocating the fact and deleting the line. ` +
      `Return ONE object summarizing the group: verdict=the dominant action, and in "rationale" give a per-line ` +
      `breakdown (line N: <verdict> — <why>). index_action should list per-line line actions. unit="inline:${g.section}", kind="inline".`,
    { label: `inline:${g.section}`, phase: 'Classify', model: 'sonnet', schema: SCHEMA },
  ).then((v) => (v ? { ...v, kind: 'inline' } : null)),
)

const classified = (await parallel([...fileThunks, ...inlineThunks])).filter(Boolean)
log(`classified ${classified.length}/${FILES.length + INLINE_GROUPS.length} units`)

// ---- Phase 2: synthesis barrier ---------------------------------------------
phase('Synthesize')
const report = await agent(
  `You are the synthesis stage of a committed-memory audit (${MEMDIR}/, indexed by MEMORY.md).\n` +
    `Here are ${classified.length} per-unit verdicts as JSON:\n\n${JSON.stringify(classified, null, 2)}\n\n` +
    `Produce a consolidated review. Tasks:\n` +
    `1. CROSS-MEMORY CONFLICTS: find units whose facts contradict each other or whose verdicts collide ` +
    `(e.g. two deletes that reference the same still-open concern). List them under "Conflicts".\n` +
    `2. MOVE BLOAT GUARD: if many units want to move into the SAME CLAUDE.md/skill file, say so and recommend ` +
    `whether to batch or drop low-value ones — moving everything bloats the target.\n` +
    `3. PARTITION every unit into exactly these buckets:\n` +
    `   - AUTO-SAFE: safe_auto===true (non-destructive index fixes + high-confidence evidence-backed deletes). ` +
    `For each give the EXACT mechanical action (delete file X + its MEMORY.md line N; or add line under section S).\n` +
    `   - NEEDS-REVIEW: every move/merge/flag and every medium/low-confidence delete, with the open question.\n` +
    `   - KEEP: no action.\n` +
    `4. INDEX INTEGRITY: list orphan files (no index line) and any stale/broken index lines, with the fix.\n` +
    `Return a clean markdown report with those sections, an action count summary at top, and a final ` +
    `"Apply order" checklist for the AUTO-SAFE bucket. Be concrete: name files and MEMORY.md line numbers.`,
  { label: 'synthesize', phase: 'Synthesize' },
)

return { classified, report }
