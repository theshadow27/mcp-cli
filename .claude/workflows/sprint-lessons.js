export const meta = {
  name: 'sprint-lessons',
  description: 'Extract actionable lessons from sprint session history: classify + scan each session, deep-dive orchestrators, aggregate per-sprint, per-10-sprint window, and over time.',
  whenToUse: 'Mining Claude Code sprint history for what worked, what broke, and how the operation has evolved. Invoked by the sprint-lessons skill, which feeds it pre-computed session digests via a generated /tmp runner.',
  phases: [
    { title: 'Per-session', detail: 'haiku: classify orchestrator/worker, scan errors/rejections/interventions, summarize' },
    { title: 'Orchestrator deep-dive', detail: 'sonnet: model-routing logic, user feedback, decisions, antipatterns' },
    { title: 'Sprint aggregate', detail: 'one agent per sprint folds its sessions into a picture' },
    { title: 'Window aggregate', detail: 'one agent per 10-sprint window — recurring issues + lessons' },
    { title: 'Trend', detail: 'single agent: how the operation changed over time + what to do about it' },
  ],
}

// ── args contract (fed by the skill's /tmp runner) ──────────────────────────
// args = {
//   runDir:     "/tmp/sprint-lessons-<ts>",
//   windowSize: 10,
//   sprints: [ {
//     sprint: "57", label: "sprint-0057",
//     sessions: [ { id, digestPath, sizeBytes, roleHint, durationMin, totalOutputTokens } ]
//   } ]
// }
// Each digestPath points at a small pre-computed JSON digest (deterministic
// facts + bounded evidence) written by extract-sprint-sessions.ts. Agents READ
// the digest — they never parse raw multi-MB transcripts, and they never
// recompute token/duration numbers (those are authoritative in the digest).

const input = args || {}
const allSprints = (input.sprints || []).filter((s) => s && s.sessions && s.sessions.length)
const windowSize = input.windowSize || 10

if (!allSprints.length) {
  log('No sprints/sessions in args — nothing to analyze. Did the extractor run?')
  return { error: 'empty-input', sprints: 0 }
}

const flatSessions = allSprints.flatMap((s) =>
  s.sessions.map((sess) => ({ ...sess, sprint: s.sprint, label: s.label })),
)
log(`${flatSessions.length} sessions across ${allSprints.length} sprints (windows of ${windowSize})`)

// ── structured-output schemas ───────────────────────────────────────────────
const ISSUE = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'severity', 'detail'],
  properties: {
    kind: {
      type: 'string',
      enum: ['tool-error', 'autoclassifier-rejection', 'api-error', 'quota-limit',
        'user-correction', 'rework-loop', 'stuck', 'flaky-test', 'process-violation', 'other'],
    },
    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
    detail: { type: 'string', description: 'One sentence, concrete, quote evidence where possible.' },
  },
}

const SESSION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['role', 'oneLine', 'whatItDid', 'issues', 'lessons'],
  properties: {
    role: { type: 'string', enum: ['orchestrator', 'worker', 'planning', 'exploratory', 'unknown'] },
    roleConfidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    oneLine: { type: 'string', description: 'One-line label for this session.' },
    whatItDid: { type: 'string', description: '2-4 sentences. Concrete: issues/PRs touched, outcome.' },
    outcome: { type: 'string', enum: ['succeeded', 'partial', 'failed', 'abandoned', 'unknown'] },
    issues: { type: 'array', items: ISSUE },
    lessons: {
      type: 'array',
      items: { type: 'string', description: 'Actionable, generalizable lesson — not a restatement of what happened.' },
    },
  },
}

const ORCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['modelLogic', 'userFeedback', 'decisions', 'antipatterns'],
  properties: {
    modelLogic: {
      type: 'array',
      description: 'Observed model-routing / delegation logic (which model for what, why, and whether it worked).',
      items: { type: 'string' },
    },
    userFeedback: {
      type: 'array',
      description: 'Verbatim-or-close user interventions/corrections and what triggered them.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['feedback', 'category'],
        properties: {
          feedback: { type: 'string' },
          category: { type: 'string', enum: ['correction', 'preference', 'authorization', 'praise', 'redirection', 'other'] },
        },
      },
    },
    decisions: { type: 'array', items: { type: 'string', description: 'Notable orchestration decision + its consequence.' } },
    antipatterns: { type: 'array', items: { type: 'string', description: 'Orchestration antipattern observed (context rot, blind polling, redundant fan-out, etc.).' } },
  },
}

const SPRINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'themes', 'topIssues', 'topLessons'],
  properties: {
    summary: { type: 'string', description: '3-6 sentence picture of the sprint from its sessions.' },
    themes: { type: 'array', items: { type: 'string' } },
    topIssues: { type: 'array', items: ISSUE },
    topLessons: { type: 'array', items: { type: 'string' } },
    healthSignals: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reworkLoops: { type: 'integer' },
        autoclassifierRejections: { type: 'integer' },
        quotaOrApiStalls: { type: 'integer' },
        processViolations: { type: 'integer' },
      },
    },
  },
}

const WINDOW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['narrative', 'recurringIssues', 'recurringLessons', 'metricsTrend'],
  properties: {
    narrative: { type: 'string', description: '1-2 paragraphs: the picture across these sprints.' },
    recurringIssues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'sprintsSeen', 'status'],
        properties: {
          issue: { type: 'string' },
          sprintsSeen: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', enum: ['worsening', 'persistent', 'improving', 'resolved'] },
        },
      },
    },
    recurringLessons: { type: 'array', items: { type: 'string' } },
    metricsTrend: { type: 'string', description: 'How tokens/sessions/error-rate moved across the window.' },
  },
}

const TREND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['evolutionNarrative', 'actionable', 'improvements', 'regressions'],
  properties: {
    evolutionNarrative: { type: 'string', description: 'How the sprint operation has changed across all windows — concrete and specific.' },
    improvements: { type: 'array', items: { type: 'string', description: 'What got measurably better and (if visible) what change caused it.' } },
    regressions: { type: 'array', items: { type: 'string', description: 'What got worse or recurs unfixed.' } },
    actionable: {
      type: 'array',
      description: 'Ranked, concrete actions. Each should be something a future session or a rule/skill change could implement.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'rationale', 'priority'],
        properties: {
          action: { type: 'string' },
          rationale: { type: 'string', description: 'Evidence from the history that motivates this.' },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
          target: { type: 'string', description: 'Where it would land: a rule, a skill, CLAUDE.md, daemon behavior, etc.' },
        },
      },
    },
  },
}

// ── prompts ──────────────────────────────────────────────────────────────────
const classifyPrompt = (s) => `You are analyzing ONE Claude Code session from sprint ${s.sprint} of the mcp-cli project.

Read the pre-computed digest at: ${s.digestPath}
It is a small JSON file with deterministic facts (token totals, duration, error/error-type counts, git branches, orchestration-signal counts) and BOUNDED EVIDENCE samples (the first user prompt, real user-message turns, tool-error samples, synthetic/operational messages like API errors and quota limits, and PR links).

Do NOT recompute or second-guess the numeric facts — they are authoritative. Your job is judgment over the evidence:

1. role: orchestrator (spawns/manages other Claude sessions, runs phases, drives a sprint), worker (implements/repairs/QAs one issue), planning, exploratory, or unknown. Use the orchestration-signal counts + evidence. roleHint in the digest is a guess — confirm or override it.
2. whatItDid: concrete — which issues/PRs, what outcome (use PR links + first prompt + branches).
3. outcome: did it land? (PR merged signals success; abandoned branch / repeated errors signal otherwise.)
4. issues: scan the evidence for: tool errors (recurring or fatal), autoclassifier/usage-policy REJECTIONS (the model refusing or being blocked — look in synthetic messages and assistant turns), api-errors, quota/session limits, user CORRECTIONS (the human stepping in to fix course), rework loops, getting stuck, flaky tests, or process violations. Quote the evidence in 'detail'.
5. lessons: generalizable, actionable takeaways — NOT a restatement of what happened. Empty array is fine if there's nothing transferable.

Return ONLY the structured object.`

const orchPrompt = (s, base) => `This session (sprint ${s.sprint}) was classified as an ORCHESTRATOR. Re-read its digest at ${s.digestPath} and go deeper.

First-pass summary: ${JSON.stringify({ oneLine: base.oneLine, whatItDid: base.whatItDid })}

Extract the orchestration-specific signal:
- modelLogic: what model-routing / delegation logic is visible — which model (opus/sonnet/haiku/codex/etc.) was used for what, the stated reasoning, and whether it paid off. Note any model that was avoided/blacklisted and why.
- userFeedback: the human's interventions — corrections, preferences, authorizations (e.g. autoclassifier/commit authorizations), redirections. Quote closely; categorize each.
- decisions: orchestration decisions and their consequences (fan-out width, merge ordering, wait strategy, quota handling).
- antipatterns: orchestration failure modes in evidence — context rot, blind polling/ScheduleWakeup misuse, redundant parallel fixes, ending a turn on a passive wait, etc.

Return ONLY the structured object.`

const sprintPrompt = (sprint, label, sessionResults) => `Aggregate the session-level findings for ${label} (sprint ${sprint}) of mcp-cli into one picture.

Here are the per-session results (${sessionResults.length} sessions), already classified and scanned:
${JSON.stringify(sessionResults, null, 1)}

Produce the sprint picture: a 3-6 sentence summary, the dominant themes, the top issues (dedup across sessions — one entry per distinct problem, severity = worst seen), the top transferable lessons, and integer health signals (count rework loops, autoclassifier rejections, quota/api stalls, process violations across the sprint). Return ONLY the structured object.`

const windowPrompt = (range, sprintSummaries) => `Aggregate ${sprintSummaries.length} consecutive sprints (${range}) of mcp-cli into a window-level view.

Per-sprint summaries:
${JSON.stringify(sprintSummaries, null, 1)}

Find what RECURS, not just what happened once. For recurringIssues, list the sprints each was seen in and judge its trajectory (worsening/persistent/improving/resolved). recurringLessons = lessons that show up repeatedly or compound. metricsTrend = how token spend / session count / error density moved across the window (qualitative is fine; numbers are in the summaries). Return ONLY the structured object.`

const trendPrompt = (windowSummaries) => `You have window-level summaries spanning the full sprint history of mcp-cli (each window = ~${windowSize} sprints):
${JSON.stringify(windowSummaries, null, 1)}

Zoom all the way out. How has this autonomous-sprint operation CHANGED over time?
- evolutionNarrative: the arc — what the operation looked like early vs late, and the inflection points.
- improvements: what measurably got better and (if visible from the windows) what change drove it.
- regressions: what got worse or keeps recurring unfixed.
- actionable: ranked, CONCRETE actions grounded in this history. Each must be implementable — a doing-it-wrong rule, a skill/CLAUDE.md change, a daemon behavior, a process change — with the historical evidence that motivates it and a target. Prioritize P0/P1/P2.

Return ONLY the structured object.`

// ── Phase 1+2: per-session classify, then orchestrator deep-dive (pipelined) ─
const sessionResults = await pipeline(
  flatSessions,
  (s) => agent(classifyPrompt(s), {
    label: `s${s.sprint}:${String(s.id).slice(0, 8)}`,
    phase: 'Per-session',
    model: 'haiku',
    schema: SESSION_SCHEMA,
  }).then((r) => (r ? { ...r, id: s.id, sprint: s.sprint, label: s.label, _s: s } : null)),

  (base) => {
    if (!base) return null
    const s = base._s
    if (base.role !== 'orchestrator') {
      const { _s, ...clean } = base
      return clean
    }
    return agent(orchPrompt(s, base), {
      label: `orch:${String(s.id).slice(0, 8)}`,
      phase: 'Orchestrator deep-dive',
      model: 'sonnet',
      schema: ORCH_SCHEMA,
    }).then((deep) => {
      const { _s, ...clean } = base
      return { ...clean, orchestrator: deep || null }
    })
  },
)

const cleanResults = sessionResults.filter(Boolean)
log(`Per-session done: ${cleanResults.length} analyzed, ${cleanResults.filter((r) => r.role === 'orchestrator').length} orchestrators`)

// ── group results by sprint (plain code — needs all sessions of a sprint) ────
const bySprint = new Map()
for (const r of cleanResults) {
  const k = r.sprint
  if (!bySprint.has(k)) bySprint.set(k, [])
  bySprint.get(k).push(r)
}
const sprintNum = (s) => (/^\d+$/.test(String(s)) ? Number(s) : -1)
const orderedSprints = [...bySprint.keys()].sort((a, b) => sprintNum(a) - sprintNum(b))

// ── Phase 3: per-sprint aggregate (barrier: all sessions of each sprint done) ─
phase('Sprint aggregate')
const sprintSummaries = (await parallel(
  orderedSprints.map((sprint) => () => {
    const results = bySprint.get(sprint)
    const label = results[0]?.label || `sprint-${sprint}`
    // strip nested orchestrator detail to keep the aggregate prompt bounded;
    // its lessons/antipatterns are folded up here.
    const compact = results.map((r) => ({
      role: r.role, oneLine: r.oneLine, whatItDid: r.whatItDid, outcome: r.outcome,
      issues: r.issues, lessons: r.lessons,
      orchestrator: r.orchestrator
        ? { antipatterns: r.orchestrator.antipatterns, decisions: r.orchestrator.decisions, userFeedback: r.orchestrator.userFeedback }
        : undefined,
    }))
    return agent(sprintPrompt(sprint, label, compact), {
      label: `agg:${label}`,
      phase: 'Sprint aggregate',
      model: 'sonnet',
      schema: SPRINT_SCHEMA,
    }).then((a) => (a ? { sprint, label, sessionCount: results.length, ...a } : null))
  }),
)).filter(Boolean)

// ── Phase 4: window aggregate (chunks of windowSize sprints) ─────────────────
phase('Window aggregate')
const windows = []
for (let i = 0; i < sprintSummaries.length; i += windowSize) {
  windows.push(sprintSummaries.slice(i, i + windowSize))
}
const windowSummaries = (await parallel(
  windows.map((chunk, idx) => () => {
    const range = `sprint ${chunk[0].sprint}–${chunk[chunk.length - 1].sprint}`
    return agent(windowPrompt(range, chunk), {
      label: `win${idx + 1}:${range}`,
      phase: 'Window aggregate',
      model: 'sonnet',
      schema: WINDOW_SCHEMA,
    }).then((w) => (w ? { window: idx + 1, sprintRange: range, ...w } : null))
  }),
)).filter(Boolean)

// ── Phase 5: over-time trend (single synthesis) ──────────────────────────────
phase('Trend')
const trend = await agent(trendPrompt(windowSummaries), {
  label: 'over-time-trend',
  phase: 'Trend',
  model: 'sonnet',
  schema: TREND_SCHEMA,
})

log('Done. Returning structured report.')
return {
  meta: { sprints: orderedSprints.length, sessions: cleanResults.length, windows: windows.length, runDir: input.runDir },
  sessionResults: cleanResults.map(({ _s, ...r }) => r),
  sprintSummaries,
  windowSummaries,
  trend,
}
