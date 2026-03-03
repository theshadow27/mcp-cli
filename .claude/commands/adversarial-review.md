---
description: Adversarial PR review with multi-agent second opinions
---

Adversarial review of the current branch's PR. Be critical, not agreeable.

1. Get the PR diff and understand every change
2. Do your own thorough, skeptical review first. Protect this code like Linus protects Linux.
3. Launch these agents **in parallel** for second opinions:
   - **eigenbot** — unfiltered technical critique
   - **pessimist-prime** — failure mode analysis
   - **chaos-dancer** — user abuse/social weaponization vectors (if applicable)
4. Synthesize all perspectives into a single actionable review of issues to resolve before merge

- If issues are out of scope of the PR description, offer to create follow-up issues in gh.

5. Use gh review to post review comments (including any followup issues, and requested changes)
