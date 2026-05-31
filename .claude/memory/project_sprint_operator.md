---
name: project-sprint-operator
description: "North-star — the sprint orchestrator is a Kubernetes-style operator; backlog as declarative CRD reconciled to \"all green/purple\""
metadata: 
  node_type: memory
  type: project
  originSessionId: 00936166-d790-4b6c-bf48-b258bb79d76f
---

The strategic direction for sprint orchestration (epic **#2577**): reframe the LLM orchestrator as a **level-triggered reconciler / operator** (Kubernetes-controller pattern), not a sequential workflow.

- **Backlog = declarative desired state** (GitOps for engineering work). `sprint-N.yml` is the CRD; `work_items` rows are the resource instances; `mcx flow apply sprint-N.yml` is `kubectl apply`. Terminal/converged condition = `∀ work_item: phase=done` ("all purple" = all merged).
- **Crash-resumable because the loop holds no state** — it's a pure function of `work_items` + PR/CI/label state. Resume = just re-run; re-derive next action from observed truth. Correctness across crashes requires every effect be **queryable-or-idempotent** (the (a)/(b) discipline) — that discipline IS the resumability precondition. The two real side effects (spawn, merge) are already guarded (session_id sentinel; `prView==MERGED` precheck).
- **Journal vs reconciler:** journal is right for the *pure-compute interior* (claude `Workflow` runtime, #2576); reconciler-over-external-state is right for the *effectful outer loop*. Don't conflate them — `mcx flow` uses both. See [[reference-claude-workflow-runtime]] if written.
- **Where the analogy breaks (harder than k8s):** operands are non-deterministic (LLM stays in the leaf for quality judgment); desired state under-specified (convergence not guaranteed; round-caps = escalate); merges irreversible (why typed verdict #2575 + CI gate are load-bearing); external/multi-repo needs containerization + credential sandbox.
- **The commercial moat is the control plane, not the LLM.** Durable + idempotent + observable reconciliation with a replayable forensic log (deterministic `observe→decide→apply`, LLM confined to logged leaf escalations) — that's the defensible bedrock; the model is a swappable operand.

**Why:** the orchestrator currently burns ~50% of sprint tokens on >200k (surcharged) sessions doing 97%-mechanical edge-driving. A deterministic controller + fresh-context model only on escalation collapses that cost AND makes the sprint auditable.

**How to apply:** load-bearing near-term is **Stage 0** (emit `review:pass`/`review:changes` labels — copy qa's structured-label pattern — to make the FSM fully structured + close #2575's consumer side) and **Stage 1** (daemon-hosted reconciler, #1942/#1944). Stages 2–3 (`mcx flow apply`, containerized multi-repo) are the north-star. Constellation: #2577→#1942/#2024/#2576/#2575/#1397.
