# why-workflow.js — Stage 2 fan-out (the council for answers)

Mirrors the `/council` pattern, but the unit of work is **one reframe question**, not a whole problem, and the panel is fixed.

## Args

| arg | type | meaning |
|---|---|---|
| `questions` | `string[]` (required) | the Stage-1 reframe questions |
| `context` | `string` | the subject + whatever was already loaded when `/why` fired. Seats answer from THIS + reasoning — they do not explore (same discipline as the knowable gate). |

## The four seats

Diversity = model tier **×** framing. The point is not redundancy; it's that lower tiers state plainly what the top tier reasons its way around.

| seat | model | job |
|---|---|---|
| `structural` | opus | deepest, least-convenient answer; the real cause + what the frame omits |
| `pragmatic` | sonnet | cheapest real unblock; Friday-afternoon senior-engineer move |
| `dumb` | sonnet | says the obvious thing out loud; refuses unexplained complexity |
| `literal` | haiku | naive face-value read; emperor-has-no-clothes; near-free |

Four seats → naturally feeds the "ideally 4 paths forward" target.

## Why three orderings (position-bias control)

Per question, the same seat answers are handed to the adjudicator **three times in different orders** (identity, index-seeded rotation, reversal). LLM adjudicators anchor on whatever is listed first; presenting the set reordered forces a position-*invariant* pick. Workflows ban `Math.random`/`Date.now`, which is the right constraint here — we want a reproducible reshuffle, not a coin flip, so a re-run adjudicates identically.

## Pipeline

1. **Investigate** — every `(question × seat)` pair runs concurrently (barrier: aggregation needs all seats per question).
2. **Adjudicate** — per question, one opus adjudicator sees all three orderings → position-invariant best answer + carried-forward dissent.
3. **Synthesize** — one opus pass → a headline (the single sharpest thing, often "this can be deleted") + **2–4 distinct paths forward**.

## What it returns

```
{ questions, perQuestion: [{question, bestAnswer, why, dissent, positionStable}], headline, pathsForward: [{summary, rationale, tradeoff}] }
```

Paths are **options**, never a chosen plan. Choosing is Stage 3 (`references/plan.md`), and only on a call to action.
