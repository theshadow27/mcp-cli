export const meta = {
  name: 'why-investigate',
  description: 'Stage 2 of /why — fan out diverse investigator seats to answer the reframe questions, aggregate with a position-bias control, adjudicate to the best answer per question, then synthesize 2-4 paths forward. Surfaces options; does NOT prescribe one.',
  phases: [
    { title: 'Investigate — diverse seats answer each question' },
    { title: 'Adjudicate — position-invariant best answer per question' },
    { title: 'Synthesize — 2-4 paths forward' },
  ],
}

// =============================================================================
// args:
//   questions (string[], required) — the Stage-1 reframe questions.
//   context   (string)             — the subject + whatever relevant context the
//                                    orchestrator already had loaded when /why fired.
//                                    NB: seats do NOT explore; they answer from this
//                                    context + their own reasoning, like Stage 1's gate.
// =============================================================================
const A = (typeof args === 'string' ? JSON.parse(args) : args) || {}
const QUESTIONS = Array.isArray(A.questions) ? A.questions.filter(Boolean) : []
const CONTEXT = (A.context || '').toString()
if (!QUESTIONS.length) throw new Error('why-investigate: args.questions (non-empty string[]) is required')

// ---- the seats --------------------------------------------------------------
// Diversity is BOTH model tier AND framing. The observed effect: lower tiers will
// state plainly what the top tier reasons its way around. The naive-literalist
// (haiku) seat is near-free and exists precisely to say the obvious thing.
const SEATS = [
  { id: 'structural', model: 'opus',   lens: 'Deep structural reasoning. Trace the real cause, second-order effects, and what the question is pointing at that the frame omits. The most rigorous, least convenient answer.' },
  { id: 'pragmatic',  model: 'sonnet', lens: 'Ship-it pragmatism. What actually unblocks this for the least cost? What does a senior engineer do on a Friday afternoon? Concrete, not clever.' },
  { id: 'dumb',       model: 'sonnet', lens: 'Ask the dumb question out loud. State the obvious thing everyone is too clever to say. Refuse unexplained complexity. "Why does this exist at all?"' },
  { id: 'literal',    model: 'haiku',  lens: 'Naive literalist. Take the question at absolute face value, no nuance, no hedging. The emperor-has-no-clothes read. Shortest honest answer.' },
]

const ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    answer: { type: 'string', description: 'Direct answer to THIS question. No preamble.' },
    basis: { type: 'string', enum: ['from-context', 'from-reasoning', 'unknowable-without-tools'], description: 'Where the answer comes from. Be honest: if it cannot be answered from the supplied context + reasoning, say unknowable-without-tools.' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['answer', 'basis', 'confidence'],
}

// =============================================================================
// Phase 1 — Investigate. Every (question x seat) pair, concurrently.
// Barrier is justified: shuffle + adjudication need all seats for a question.
// =============================================================================
phase('Investigate — diverse seats answer each question')

const pairs = []
QUESTIONS.forEach((q, qi) => SEATS.forEach(seat => pairs.push({ qi, q, seat })))

const grid = await parallel(pairs.map(({ qi, q, seat }) => () =>
  agent(
    [
      `You are the "${seat.id}" investigator seat. Framing: ${seat.lens}`,
      ``,
      `CONTEXT in which /why was invoked (this is all you have — do NOT explore, do NOT call tools; answer from this + your reasoning):`,
      CONTEXT || '(no additional context supplied)',
      ``,
      `QUESTION to answer: ${q}`,
      ``,
      `Answer ONLY this question, in your seat's voice. If it genuinely cannot be answered from the context above plus reasoning, set basis=unknowable-without-tools and say what single fact would unlock it.`,
    ].join('\n'),
    { label: `seat:${seat.id} q${qi + 1}`, phase: 'Investigate — diverse seats answer each question', model: seat.model, schema: ANSWER_SCHEMA }
  ).then(a => ({ qi, seatId: seat.id, model: seat.model, ...a }))
))

// group answers by question
const byQuestion = QUESTIONS.map((q, qi) => ({
  qi, question: q,
  answers: grid.filter(Boolean).filter(a => a.qi === qi),
}))

// ---- position-bias control: 3 deterministic reorderings of the same answers --
// Workflows ban Math.random/Date.now, which is exactly right here — we want a
// reproducible reshuffle, not a coin flip. Identity, an index-seeded rotation,
// and a reversal give the adjudicator the same set in three orders so it cannot
// anchor on whichever answer happened to be listed first.
const rotate = (arr, k) => arr.map((_, i) => arr[(i + k) % arr.length])
const orderingsFor = (arr, qi) => [
  arr,                          // as-investigated
  rotate(arr, 1 + (qi % Math.max(1, arr.length))), // seeded rotation
  [...arr].reverse(),           // reversed
].map(o => o.map((a, idx) => `[${idx + 1}] (${a.seatId}/${a.model}, conf ${a.confidence}) ${a.answer}`).join('\n\n'))

// =============================================================================
// Phase 2 — Adjudicate per question across the 3 orderings.
// =============================================================================
phase('Adjudicate — position-invariant best answer per question')

const ADJ_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    bestAnswer: { type: 'string', description: 'The strongest answer to the question, synthesized if two seats are jointly right.' },
    why: { type: 'string', description: 'Why this beats the others. One or two sentences.' },
    dissent: { type: 'string', description: 'The most important disagreement or caveat worth carrying forward. Empty string if none.' },
    positionStable: { type: 'boolean', description: 'True if the same answer wins regardless of ordering.' },
  },
  required: ['bestAnswer', 'why', 'dissent', 'positionStable'],
}

const adjudicated = await parallel(byQuestion.map(qa => () => {
  const orderings = orderingsFor(qa.answers, qa.qi)
  return agent(
    [
      `You are the adjudicator for ONE /why question. Below is the SAME set of seat answers presented THREE times in different orders — this is a deliberate position-bias control. Pick the answer that is strongest REGARDLESS of where it appears. Synthesize if two seats are each partly right. Do not reward verbosity or recency.`,
      ``,
      `QUESTION: ${qa.question}`,
      ``,
      `--- Ordering A ---`, orderings[0],
      ``, `--- Ordering B ---`, orderings[1],
      ``, `--- Ordering C ---`, orderings[2],
    ].join('\n'),
    { label: `adjudicate q${qa.qi + 1}`, phase: 'Adjudicate — position-invariant best answer per question', model: 'opus', schema: ADJ_SCHEMA }
  ).then(v => ({ question: qa.question, ...v }))
}))

// =============================================================================
// Phase 3 — Synthesize 2-4 paths forward across all adjudicated answers.
// These are OPTIONS, not a chosen plan. /why never prescribes.
// =============================================================================
phase('Synthesize — 2-4 paths forward')

const PATHS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    paths: {
      type: 'array', minItems: 2, maxItems: 4,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          summary: { type: 'string', description: 'The path in one line (often a verb: delete X, revert Y, question Z).' },
          rationale: { type: 'string' },
          tradeoff: { type: 'string', description: 'What you give up / what must be true for this to be the right call.' },
        },
        required: ['summary', 'rationale', 'tradeoff'],
      },
    },
    headline: { type: 'string', description: 'The single most important thing the investigation surfaced. One sentence.' },
  },
  required: ['paths', 'headline'],
}

const synthesis = await agent(
  [
    `Synthesize 2-4 distinct PATHS FORWARD from the adjudicated answers below. Ideally 4. They must be genuinely different directions (e.g. delete-the-subject, revert-to-baseline, question-the-requirement, accept-with-rationale) — not one plan in four costumes. Present options. Do NOT pick one; choosing is out of scope for /why.`,
    `Lead with the headline: the single sharpest thing this surfaced — frequently "this should not exist / can be deleted".`,
    ``,
    `Original context: ${CONTEXT || '(none supplied)'}`,
    ``,
    `Adjudicated answers:`,
    ...adjudicated.filter(Boolean).map((a, i) => `Q${i + 1}: ${a.question}\n  → ${a.bestAnswer}${a.dissent ? `\n  (dissent: ${a.dissent})` : ''}`),
  ].join('\n'),
  { label: 'synthesize paths', phase: 'Synthesize — 2-4 paths forward', model: 'opus', schema: PATHS_SCHEMA }
)

return {
  questions: QUESTIONS,
  perQuestion: adjudicated.filter(Boolean),
  headline: synthesis?.headline,
  pathsForward: synthesis?.paths ?? [],
}
