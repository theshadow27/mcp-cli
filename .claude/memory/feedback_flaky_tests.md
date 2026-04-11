---
name: flaky test fix policy
description: Flaky test issues always get opus implementation + adversarial review to prevent fix/re-break cycles
type: feedback
---

Flaky test issues must always get opus implementation + adversarial review, regardless of scrutiny classification.

**Why:** Sprint 15-19 saw cycles where flaky tests were "fixed" with superficial changes (longer timeouts, retry loops) that passed locally but failed again under CI load. The same tests kept getting re-filed.

**How to apply:** When the sprint plan has a flaky test issue (title contains "flaky" or label `flaky`):
1. Always implement on opus (never sonnet)
2. Always adversarial review after implementation
3. Review must verify root cause elimination, not symptom masking
4. Reject fixes that just increase timeouts or add retries without addressing the race condition
