---
name: git-https-push
description: When agents get stuck pushing, tell them to use HTTPS remote instead of SSH
type: feedback
---

SSH git push can be flaky. If a spawned session gets stuck on push, send them a message to push via HTTPS instead.

**Why:** Intermittent SSH connectivity issues cause agents to hang on `git push`.
**How to apply:** Monitor for sessions that stall during push phase. Send: "Push via HTTPS: `git remote set-url origin https://github.com/<owner>/<repo>.git` then retry push."
