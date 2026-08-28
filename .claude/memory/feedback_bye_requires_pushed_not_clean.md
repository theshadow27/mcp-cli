---
name: feedback_bye_requires_pushed_not_clean
description: "Before byeing an implementer/repair session, check `git log origin/<branch>..HEAD` is empty — `git status` clean means committed, not pushed"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ccf4f20a-deb6-46fa-8467-31eaa35e34ca
  modified: 2026-08-26T22:51:57.662Z
---

Never `mcx claude bye` a session on the strength of `git status --short` being clean.
A worktree is clean the instant the session **commits** — pushing is a separate act.
Bye it 30 seconds early and the commit is stranded locally while the PR head is stale.

The liveness check before ending an implementer/repair session is:

```bash
git log origin/<branch>..HEAD   # must be empty
```

**Why:** sprint 81, #3209 / PR #3374. The repair committed `f5c6fc51` (a test-only
+12/-1 commit) at 22:15:04Z; I byed the session at ~22:15:30Z having seen a clean
`git status`. PR head stayed at `fb275d81`. The QA session then ran in that same
worktree, verified the **local** tree — which had the commit — and posted `qa:pass`
citing `packages/daemon/src/domain-resolver.spec.ts:81-84`. The merge candidate did not
contain that file's change. Merging there would have shipped a tree nobody verified,
with a QA comment that read as if it had been.

**How to apply:** gate the bye on `git log origin/<branch>..HEAD` being empty, not on
`git status`. When a QA/review verdict cites a commit SHA or a file, confirm the SHA is
an ancestor of the **PR head** (`gh pr view N --json headRefOid`), not merely present
locally — `git branch --contains <sha>` matching a *local* branch proves nothing about
what would merge. If a verdict turns out to describe an unpushed tree, push the authored
commit and let CI re-green rather than re-running QA; the verification was real, only
its subject was missing. Note the trap that a `git ls-tree`/grep in the wrong package
will falsely "disprove" a correct citation — check the path the verdict actually gave.

Related: [[feedback_verify_merge_actually_fired]], [[feedback_verdict_must_reach_the_pr]]
— same family: the artifact must reach the shared surface, not just exist somewhere.
