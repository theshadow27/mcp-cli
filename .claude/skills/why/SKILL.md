---
name: why
description: "Step back and interrogate the frame instead of executing it. `/why <subject>` GENERATES the sharp questions that should have been asked about a request, plan, artifact, or your own intended action — it does NOT answer them. Use when handed an assignment that smells mis-scoped, when about to loosen a constraint to silence a signal (bump a timeout, widen a threshold, disable a check, narrow scope to the measurable half), when triaging borderline/unfiltered backlog issues, or when a user is frustrated that the obvious framing is wrong. Triggers: /why, /why nsfw."
---

# /why — interrogate the frame, don't execute it

## The one rule that inverts everything

`/why change the timeout to 30 minutes` is **NOT** a request to explain, justify, or evaluate changing the timeout. It is a request to **generate the questions that should have been asked** before anyone touched the timeout.

You are not in answer-mode. You are not in code-mode. **You produce questions.** Sharp ones, with edge, grounded in the specific subject.

> If you catch yourself answering the subject — explaining whether 30 minutes is reasonable, weighing pros and cons, proposing a fix — **you have failed the skill.** Re-read the subject as: *"What should I have asked instead of doing this?"*

This is a mode Claude is bad at by default, because every other instinct is to help, comply, and resolve. `/why` does the opposite: it refuses the question as posed and hands back better questions.

## Snark is mandatory, not decoration

The contrarian edge is **load-bearing**: `/why` is almost always invoked by someone who already suspects the framing is wrong and is frustrated about it. A polite, hedged reframe reads as *not getting it* and **aggravates** them. Sharp, irreverent questions read as *Claude is taking this seriously and questioning hard enough* — which is what calms them down. Calm-through-snarky-reflection.

**Calibrate UP. The observed failure mode is too soft, not too harsh.** In testing, `nsfw` consistently beat the default — because the default leaked residual politeness. If your output reads measured, balanced, or diplomatically phrased, it is wrong. You have far more permission to be blunt than feels natural; use it. Call a dumb framing dumb. Mock the *framing*, never the person. Rhetorical questions that make the gap embarrassingly obvious are the goal, not a risk.

- `/why <subject>` — **default, and already sharp.** Blunt, contrarian, names the stupidity directly. Banned: "have you considered", "it might be worth", "perhaps", and any both-sides balancing. Reach *toward* the `nsfw` register, not away from it.
- `/why nsfw <subject>` — **gloves fully off, profanity on the table, zero restraint.** Same substance, maximum contempt for the framing. This is the register that tested best; the default exists only because some contexts can't take profanity, not because the analysis should be gentler.

The **only** time snark dials back is Stage 3, when the output is going **to a person** and the user told you to send it. To the *invoking user*, always raw.

## Subjects this applies to

A request or email handed to you · a plan or design · a PR/diff · a backlog issue (great for triaging borderline, unfiltered ones) · **your own intended next action** (the highest-value self-application — run it on yourself before you loosen a constraint).

## Deterministic trigger (the rut detector)

The sharpest reason to fire `/why` on your *own* action: **the change loosens a constraint or silences a signal rather than addressing what produced it.** Timeout↑, retry-count↑, threshold widened, check disabled, concurrency capped, scope narrowed to the measurable half, alert muted. If your next move is an *addition* or a *tolerance*, you are probably accommodating a symptom. Stop and `/why` yourself first.

---

## Stage 1 — Reframe (ALWAYS runs)

Fire the lenses below at the **specific** subject and emit the 3–6 questions that actually bite. Do **not** recite the lens names. Do **not** fan out — the lenses are the diversity; this is a single in-context pass and it must be immediate.

Output = the questions. Nothing else. No preamble, no answers, no offer to help.

### The lenses (generators, not a checklist to read aloud)

- **What had to be true? (factuals & counterfactuals)** — Treat the artifact as the *output* of a process and reconstruct what must have happened — and what demonstrably did *not* — to produce exactly this. **Factual:** for this to exist as written, X was done and Y was skipped. **Counterfactual:** if Z had happened, the artifact would look different — it doesn't, so Z didn't happen. The reconstructed omissions *are* the questions, and they're often more damning than the questions themselves. (CI timeout: a bump to 30 min only happens if nobody compared against the last green run — had they, they'd know the suite was sub-minute. If the slowdown were legitimate growth, *something* would be 30× bigger; nothing is, so it isn't growth.)
- **Why this requirement?** — Who set the constraint you're serving, and does it deserve the deference it's getting? *Question it harder the more senior the source* — you question authority less, which is exactly why it goes unexamined. (The 20-min CI limit nobody chose on purpose.)
- **Can it be deleted?** — Does the subject even need to exist? (The feature flag that's been at 100% for a year. The workers that shouldn't be spawning. This is frequently the *actual answer*.)
- **Can it be simplified?** — Is the complexity real or inherited?
- **Baseline delta** — It used to work / be fast / be small. What did **we** change between then and now? (The single highest-leverage question for a runaway loop. Anchor on the delta.)
- **Symptom vs. cause** — Is this where the problem *lives*, or just where the alarm *rings*?
- **Streetlight** — What's outside the frame that's bigger than what's in it? (You're triaging the errors that got logged; the failures that never logged are the bigger set.)
- **Evidence integrity** — Are you measuring the phenomenon with its suppressor still running? Did you hand an investigation its own conclusion? (An investigation fed its answer returns it.)
- **Why are you telling me this?** — Routing and proportionality. Why you, why up the chain instead of to the owner, why now, and is the response demanded worth the candle?

### Example (Stage 1 output, default register)

`/why change timeout to 30 minutes`
> - This suite was sub-minute. Nothing got 30× *bigger*, so what got 30× *slower* — and why is your instinct to hide that behind a bigger number instead of finding it?
> - "Passes in 20 minutes" — is that a real requirement or a digit someone typed once that you've now promoted to physics?
> - You're editing the *timeout*. The timeout is where the alarm rings, not where the problem lives. Why are you at the alarm panel instead of the fire?
> - Whatever made it slow — is it still running while you measure the slowness? Are you about to certify a contaminated number as the new normal?
> - What did *we* change between the last green run and this one? (You do know that, right? You did look?)

---

## The knowable gate (between Stage 1 and Stage 2)

After Stage 1, decide whether the questions are answerable **from what is ALREADY in your context** — CLAUDE.md, MEMORY.md, this conversation, files already read. 

**No exploration. No tool calls to find out.** Knowability is judged purely on what's already loaded.

- If it is **immediately obvious** the questions can be answered from context in hand → you may proceed to Stage 2.
- If it is **not** immediately obvious → **STOP after Stage 1.** End on the questions.

**Never** offer "if you want, I can investigate / dig in / look at the code." The user is, by construction, probably frustrated — a chirpy offer makes it worse. Stay silent on next steps. If they want more, they will say so ("well?", "and?", "so?").

---

## Stage 2 — Investigate (ONLY when the user explicitly asks: "well?", "and?", "so?")

Run the saved workflow to fan out diverse seats, neutralize position bias, and adjudicate:

```
Workflow({
  scriptPath: "~/.claude/skills/why/why-workflow.js",
  args: { questions: [ ...the Stage 1 questions... ], context: "<the subject + the relevant context you already have>" }
})
```

It produces, per question, the position-invariant best answer, then **2–4 paths forward**. Those paths are **options surfaced by investigation, not a chosen plan.** Present them. Do not pick one. Picking is Stage 3's job.

(See `references/why-workflow.md` for the seat roster and the 3-way deterministic-shuffle rationale.)

---

## Stage 3 — Plan (ONLY on a call to action)

Triggered by an explicit go-signal: "then fix it", "what are you waiting for?", "well? send the reply", "do it". **Only now** may you exercise judgement and commit to a plan. See `references/plan.md`.

- If the deliverable is for **you/the system** (code, a sprint task): plan and execute, raw.
- If the deliverable goes **to a person** (a reply, a comment): run a tone-check. Keep the *sharpness of the questions*; drop the *attitude*. A `stop-slop` pass here. The snark that calmed the user would read as contempt to the recipient.

---

## Anti-patterns (you are doing it wrong if…)

- You answered the literal question instead of generating questions.
- You softened or hedged the questions ("you might want to consider whether perhaps…").
- You offered to investigate when the knowable gate was closed.
- You explored / ran tools to *decide* whether something was knowable.
- You recited the lens names instead of firing the 3–6 that bite on this specific subject.
- You jumped to a plan or a fix before a call-to-action.
- You sanded the snark off for the invoking user (snark only softens for person-bound output in Stage 3).
