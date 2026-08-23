---
name: release-hold-v2
description: "Releases HELD until the domain-partition chain (#3160→#3200) lands; next release is v2.0.0 (first to ship mcx.db schema); never cut 1.14.x from current main"
metadata: 
  node_type: memory
  type: project
  originSessionId: 11926602-2527-443f-a31e-0063c3e37b1c
  modified: 2026-08-23T19:08:07.444Z
---

Operator decision 2026-08-23: hold all releases until the epic-A domain chain
(#3160 → #3181 → #3168 → #3175 → #3200) is merged. The next release ships the
new `mcx.db` (domains table, `domain_id` partitioning, #3143) — a breaking
schema change — so it takes a **major bump to v2.0.0**. No 1.14.x releases
from current main. Background: no release has been cut since v1.14.6
(2026-07-13); sprints 66–78 all skipped the review/release phase (sprint 78
halted at quota). Recorded on epic #3231 (workstream d). The /release skill
run at a sprint boundary should check this memory first. Related:
[[feedback_sprint78_audit_lessons]], epic #3231, #3232 (install-from-release
machinery proceeds regardless — it just has no new artifact to serve until
v2.0.0).
