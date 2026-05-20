# Copilot Code Review Setup

## What's configured today

CI skips `check`, `coverage`, `build`, and `pty-test` for docs-only PRs (files matching
`*.md` or `.claude/*`) via the `detect` job in `.github/workflows/ci.yml`. This was
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
- **User settings** — disable "Automatic Copilot code review" globally, then manually
  request `@Copilot` on source-code PRs as needed. This is the only clean path today
  and is documented below.

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

After this change, Copilot will no longer auto-request reviews on any PR opened under
repositories where the **signed-in account** is configured as the Copilot reviewer.
This setting is per GitHub user account — it must be changed by the specific account
whose Copilot auto-review requests are appearing on PRs, regardless of repository
ownership.

### Step 2 — Manually request Copilot review on source PRs as needed

Step 1 disables Copilot auto-review for **all** PRs, including source-code ones.
There is no ruleset or CI mechanism that restores selective Copilot review for
non-docs PRs without also re-enabling it for docs PRs (see the API limitation
section above — the ruleset can only target the merge branch, and the CI `detect`
job gates CI jobs only; it has no effect on Copilot review requests, which are
triggered by the ruleset independently).

The practical workaround after step 1: manually add `@Copilot` as a reviewer on
source-code PRs where you want a review. GitHub will honour the manual request even
with auto-review disabled.

A CI-driven approach that calls
`POST /repos/{owner}/{repo}/pulls/{n}/requested_reviewers` after `detect` confirms
`docs_only=false` would be race-free and automatic, but is **not currently
implemented** — see #2098 to pick that up.

### Current state summary

| Scenario | CI behaviour | Copilot review |
|---|---|---|
| Docs-only PR (`*.md`, `.claude/*`) | All jobs skip in ~5 s | Requested (unwanted noise) |
| Source PR (any `.ts` change) | Full CI runs | Requested ✓ |
| Push to `main` | Full CI runs | N/A |

Step 1 above eliminates the noise in the first row. The trade-off is that Copilot
review on source PRs becomes opt-in (manual `@Copilot` request) rather than
automatic. No automated fix for selective re-enablement is implemented today.

## References

- PR #2097 — CI skip for docs-only PRs (Part 1)
- Issue #2098 — Copilot review skip for docs-only PRs (Part 2, tracking)
- `.github/workflows/ci.yml` — `detect` job and classification logic
- `.git-hooks/classify.sh` — shared file-classification function used by pre-commit hook
