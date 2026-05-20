# Copilot Code Review Setup

## What's configured today

CI skips `check`, `coverage`, `build`, and `pty-test` for docs-only PRs (files matching
`*.md` or `.claude/**`) via the `detect` job in `.github/workflows/ci.yml`. This was
shipped in #1806 / PR #2097.

Copilot code review is **not** suppressed for docs-only PRs. That step requires a
one-time manual settings change described below.

## Why the ruleset API can't suppress it source-side

The repo uses GitHub ruleset `id 13509324`, which enables
`copilot_code_review: { review_on_push: true }` with a `conditions.ref_name` filter
targeting `~DEFAULT_BRANCH` (main). GitHub ruleset `ref_name` conditions match the
**merge target branch**, not the source branch. There is no supported API surface today
to exclude specific source-branch patterns (e.g. `sprint-*`, `meta/**`, `release/**`)
from Copilot review via rulesets.

The two non-ruleset workarounds are:

- **CI job** calling `DELETE /repos/.../pulls/{n}/requested_reviewers` — races against
  the review request (the ruleset fires before CI can run), requires `pull-requests:
  write` on every run, and is fragile by design. Not implemented.
- **User settings** — disable "Automatic Copilot code review" globally, then restore it
  via a repo ruleset scoped to non-docs source branches. This is the correct path and
  is documented below.

Tracking issue for GitHub feedback: #2098.

## One-time setup: suppress Copilot review on docs-only PRs

### Step 1 — Disable automatic Copilot code review in user settings

> Must be done by the repository owner or an admin with the matching GitHub account.

1. Sign in to GitHub.
2. Click your avatar → **Settings**.
3. In the left sidebar, click **Copilot** (under "Code, planning, and automation").
4. Scroll to **Copilot code review**.
5. Set **Automatic code review** to **Disabled**.
6. Click **Save**.

After this change, Copilot will no longer auto-request reviews on any PR for
repositories where you are the owner.

### Step 2 — Re-enable Copilot review via a ruleset scoped to source code PRs

Because step 1 disables review globally, you need a ruleset that opts source-code PRs
back in. GitHub rulesets support `ref_name` conditions on the target branch only, so
the cleanest approach is to keep the existing rule targeting `~DEFAULT_BRANCH` (main)
and rely on the fact that all PRs target main — then filter at the CI level (already
done via the `detect` job) rather than at the ruleset level.

If you want Copilot review for non-docs PRs only and are willing to accept a short
delay before the review request appears, the pattern is:

1. Leave "Automatic Copilot code review" **disabled** in user settings (step 1).
2. In the repo ruleset (`id 13509324`), **remove** the
   `copilot_code_review: { review_on_push: true }` rule.
3. Add a CI job that calls `gh api POST /repos/{owner}/{repo}/pulls/{n}/requested_reviewers`
   with `{ "reviewers": ["Copilot"] }` **after** the `detect` job confirms
   `docs_only=false`.

This approach is also fragile if GitHub changes the API shape, but it is at least
race-free (CI runs after the PR is open, and the request fires only when needed).
It is **not currently implemented** — see #2098 if you want to pick this up.

### Current state summary

| Scenario | CI behaviour | Copilot review |
|---|---|---|
| Docs-only PR (`*.md`, `.claude/**`) | All jobs skip in ~5 s | Requested (unwanted noise) |
| Source PR (any `.ts` change) | Full CI runs | Requested ✓ |
| Push to `main` | Full CI runs | N/A |

The only row that needs fixing is the first. Steps 1–2 above address it.

## References

- PR #2097 — CI skip for docs-only PRs (Part 1)
- Issue #2098 — Copilot review skip for docs-only PRs (Part 2, tracking)
- `.github/workflows/ci.yml` — `detect` job and classification logic
- `.git-hooks/classify.sh` — shared file-classification function used by pre-commit hook
