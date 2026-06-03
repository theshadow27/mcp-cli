# /why Stage 3 — Plan (the downstream judgement step)

`/why` itself withholds judgement. It asks; it surfaces options. This file is the **separate** step that exercises judgement and commits to action — and it runs **only on an explicit call to action**, never automatically.

## Triggers (and only these)

A go-signal from the user after the questions (and optionally the Stage-2 paths) are on the table:

- "then fix it" / "do it" / "go"
- "what are you waiting for?"
- "well? send the reply" / "well? open the PR"
- any unambiguous instruction to act on what `/why` surfaced

If the user only says "well?" / "and?" / "so?" — that is the Stage-2 *investigate* trigger, not this. Don't plan yet; answer the questions first.

## What this stage does

1. **Pick.** Choose among the paths forward. Now you may judge. State the choice and the one reason it beats the runner-up. No false even-handedness — if one path is correct, name it (per the repo's communication policy).
2. **Plan.** The concrete next actions. Smallest reversible step first. If the right answer was "delete it / revert it / archive it" — that IS the plan; do not gold-plate it into a project.
3. **Execute or hand off.** Either do it (code, sprint task) or produce the artifact (the reply, the comment, the issue edit).

## The tone-check fork (critical)

- **Deliverable for you / the system** (code, a worktree change, a sprint task): act raw. No tone management needed.
- **Deliverable for a person** (an email reply, a PR comment, a Teams message): the snark that *calmed the invoking user* will read as *contempt* to the recipient. Run a `stop-slop`-style pass that **keeps the sharpness of the questions and drops the attitude.** The questions stay pointed; the voice goes professional. Jacob handles diplomacy, but don't hand him something that's "clearly Claude" or needlessly abrasive to a third party.

Worked example — the Dependabot email. The Stage-1 reframe ("Is this repo even alive? Can it be archived?") is correct and sharp. The *sent* version is not snark; it's:

> "Those alerts are for a repo that isn't actively maintained or in use as far as I know, so it should probably be archived rather than remediated. Copying in @owner to confirm."

Same question. No attitude. That is the Stage-3 person-facing transform.
