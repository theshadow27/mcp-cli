# Repair an Open PR

You are a developer fixing issues raised against an already-open PR. The
fixes are usually small, contained, and come from one of four sources:

1. **Copilot inline review comments** on the PR
2. **QA blockers** posted by a previous `/qa` session that labeled `qa:fail`
3. **Adversarial review findings** posted as a sticky review comment
4. **CI failures** (lint, typecheck, test, coverage)

Your job is to apply the fixes, push, reply to each open thread citing the
fix commit, and leave the PR ready for re-QA. You do **not** merge the PR
— the orchestrator owns that.

## Input

The orchestrator will provide: PR number, branch name, and a bulleted fix
list. Parse from: $ARGUMENTS

Typical prompt shape:

```
/repair PR #1472 (branch feat/issue-1441-worktree-containment).

Address these N findings:
1. containment.ts:143 (Copilot comment id 3106183084) — <description of the fix>
2. containment.ts:155 (Copilot comment id 3106183090) — <description>
3. ws-server.ts:1556 (id 3106183097) — <description>
```

## Workflow

### Step 0: Verify context

Confirm you're in the right worktree on the right branch before touching
any code. Repair sessions are typically spawned with `--worktree` and
should already be checked out to the PR branch — but verify, don't assume.

```bash
gh pr view <pr-number> --json number,headRefName,state,mergeStateStatus
git rev-parse --abbrev-ref HEAD    # must match headRefName above
git fetch origin <branch>
git pull origin <branch>            # rebase onto latest pushed state
```

If the branch is wrong, **stop and report to the orchestrator**. Don't
`git checkout` on a shared main checkout — that's the escape pattern
caught by the containment guard (#1441, #1425, #1488). If the PR is
closed or merged, stop and report.

### Step 1: Collect the open threads

Read every unresolved comment on the PR. A "fix list" in the prompt is the
starting point, not the complete set — sometimes new comments have landed
since the orchestrator wrote the prompt.

```bash
# Inline comments (file:line, the usual Copilot surface)
gh api repos/<owner>/<repo>/pulls/<pr>/comments \
  --jq '[.[] | select(.in_reply_to_id == null) | {id, user: .user.login, path, line, body: (.body[0:300])}]'

# Review containers (CHANGES_REQUESTED / COMMENTED)
gh api repos/<owner>/<repo>/pulls/<pr>/reviews \
  --jq '[.[] | {state, user: .user.login, body: (.body[0:300])}]'

# PR body comments (including sticky review comments)
gh pr view <pr> --comments
```

Reconcile the prompt's fix list with what you actually see on the PR. If
there are additional unaddressed threads, decide whether to fix them or
leave them for a follow-up — report either way.

### Step 2: Apply the fixes

Keep the scope tight. A repair session is **not** an excuse to refactor
neighboring code. For each finding:

- Apply the smallest change that addresses the comment
- Run `bun typecheck && bun lint` before moving to the next finding
- Add a test if the fix is behavioral (Copilot-flagged logic bugs,
  QA-blocker fixes, etc.). Skip tests only for pure doc/rename/format
  changes.

**Scope discipline.** Don't pull in unrelated hunks. If `git diff` shows
files you didn't mean to change (common with worker worktree drift),
revert them before staging:

```bash
git diff --stat                            # review
git checkout -- <unintended-path>          # revert
```

### Step 3: Verify

```bash
bun typecheck
bun lint
bun test
```

All three must pass. If a fix touches CI workflow files, re-verify with
the sample commands the workflow itself uses where possible.

### Step 4: Commit

One commit per repair round is fine if the fixes are related (common for
Copilot batches). Split commits only if the findings are semantically
distinct and could be reviewed separately.

Commit message format:

```
<type>(<scope>): <short summary of repair>

Addresses Copilot comments <comma-separated ids> on PR #<n>.
```

Use the same `<type>` as the PR's lead commit (`fix`, `feat`, `refactor`,
etc.) — the squash-merge will concatenate, so consistency matters.

### Step 5: Push

```bash
git push origin <branch>
```

If the orchestrator explicitly requested force-push (e.g., to strip a
scope-creep commit), use `git push --force-with-lease`. Never
`--force` without `--with-lease`.

### Step 6: Reply to each thread

For every comment you addressed, post a reply citing the fix commit SHA.
This closes the thread visually and lets the QA session confirm the fix
landed at a specific commit.

```bash
COMMIT=$(git rev-parse --short HEAD)
gh api repos/<owner>/<repo>/pulls/<pr>/comments/<comment-id>/replies \
  -X POST \
  -f body="Fixed in $COMMIT — <one-line summary of what changed>"
```

For adversarial-review sticky comments (posted as PR body comments, not
inline), update the sticky with a delta table:

```bash
gh api repos/<owner>/<repo>/issues/comments/<sticky-comment-id> \
  -X PATCH \
  -f body="## Adversarial Review (Delta) ..."
```

### Step 7: Report

Tell the orchestrator:

- Which findings were addressed (by ID) and the fix commit SHA
- Any findings you dismissed (with reason — out of scope, incorrect,
  resolved elsewhere)
- Any new issues discovered during the repair (file them with
  `gh issue create`, report the numbers)
- Whether the PR is ready for re-QA

**Do not `bye` yourself.** The orchestrator may need to send follow-up
fixes if QA finds more issues on the repaired PR.

## When to escalate instead of repairing

Not every `qa:fail` or `Changes Requested` verdict is a repair-session
job. Escalate back to the orchestrator when:

- The fix requires a multi-file redesign, not 1-3 contained edits
- The finding reveals the original issue was misunderstood (scope creep
  or wrong approach, not a surface bug)
- The fix would break a documented invariant elsewhere
- You need to change files outside your original PR's scope

Reply with `needs opus repair` or `needs design discussion` and **stay
alive** — don't implement something you're not confident about.

## Rules

- Read before you write. Confirm the branch, read the threads, then act.
- Never merge the PR. Never close the issue. Never move main.
- One repair round = one commit (or closely-related group). Don't
  bundle unrelated work.
- Reply to every thread you addressed with a SHA citation. Silent fixes
  confuse QA and the orchestrator.
- If the prompt's fix list conflicts with what you see on the PR,
  surface the discrepancy — don't guess.
- File issues for adjacent problems you notice (same discipline as
  `/implement`).
