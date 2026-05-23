# SPIKE #1970 — Long-term replacement for `--sdk-url` Remote Control: exhaustive verification

**Status:** Analysis / verification artifact. No production code changed.
**Author:** nerd-snipe (automated deep-dive)
**Date:** 2026-05-23
**Subject:** Validate the POC recommendation — switch the Claude session transport from `--sdk-url` WebSocket to stdio `--input-format=stream-json --output-format=stream-json`, moving permission gating from `can_use_tool` to a `PreToolUse` hook routed back into mcpd.

> **Empirical basis.** Unlike the original POC (macOS arm64, claude 2.1.126), this environment HAS a working `claude` binary: **2.1.150 (Linux x86_64)**. Every "PROBE" claim below was run live against that binary. Where I could not close a gap empirically, it is called out explicitly. File:line citations are against the repo at analysis time.

---

## 1. Executive summary

**The recommendation holds.** The stdio `stream-json` transport is real, the wire protocol is byte-identical to the WS path, and the daemon's parsing/state layer (`session-state.ts`, `ndjson.ts`) is genuinely transport-agnostic. I verified the three load-bearing empirical claims directly:

- **Process persists across turns on stdio** — one process, one `session_id`, two `result` messages, `system/init` re-emitted **once per turn** (PROBE §A). ✓
- **`control_request/interrupt` and `set_model` work verbatim on stdin** — both ACKed with `control_response/success` and matching `request_id` (PROBE §F). ✓
- **`PreToolUse` hook gates tools** — hook receives `{session_id, tool_name, tool_input, tool_use_id, cwd, transcript_path, permission_mode}` on stdin, returns a `permissionDecision` on stdout, claude honors it (PROBE §C). ✓

But the plan has **three holes that change its shape**, and the "single sprint-sized PR" framing is wrong.

### Top 3 risks / holes

1. **Permission gating is not a drop-in. The hook path loses three capabilities the WS path has today.** (a) **`updatedInput` rewriting**: the WS `permissionAllow(requestId, decision.updatedInput)` (ws-server.ts:2060) lets the router *mutate* tool input before execution. The `PreToolUse` hook decision protocol (`permissionDecision: allow|deny|ask`) **cannot rewrite input** — verified the deny/allow shape; there is no `updatedInput` channel in the hook contract. (b) **Stateful containment runs *before* the router, in-process** (`ContainmentGuard`, ws-server.ts:2025-2044; containment.ts:281-361) with a strikes counter and escalation latch — moving the decision to a stateless subprocess→IPC roundtrip means containment state must live daemon-side and be keyed by session. (c) **`delegate` mode is asynchronous and non-blocking today** (ws-server.ts:2046-2056 returns and leaves the permission pending; a human later calls `claude_approve`/`claude_deny`). A blocking hook subprocess CAN wait — claude blocks on a PreToolUse hook up to its timeout (PROBE §E: hook sleeping 8s with `timeout:60` blocked the full 8s) — but it is **bounded by the hook timeout (default 600s for command hooks)**. Beyond that, claude *cancels* the hook (PROBE §D: `outcome:"cancelled"`), and the tool proceeds. So delegate becomes "blocking with a 10-minute hard ceiling," a behavior change from "pend indefinitely."

2. **A failing/unreachable daemon = fail-closed deny for every gated tool (PROBE §G).** A `PreToolUse` hook that exits non-zero with no JSON yields `outcome:"error"` and the **tool is blocked**. This is *safe* (a down daemon won't let an unsupervised worker run wild) but it means **daemon downtime makes every session unable to use any gated tool** — the worker stalls. The WS path has the same "down = dead" property at the session level, but the failure surfaces differently (connection drop → `session:disconnected`) vs. silent per-tool denials. Plus, `mcx hook` must **not** use the auto-starting `sendRequest` wrapper (daemon-lifecycle.ts:161) — a down daemon would trigger a full daemon *spawn* on a tool call, adding seconds and risking the cooldown error.

3. **`mcx hook` cold-start budget is tight and the obvious implementation blows it.** Measured (PROBE §H): trivial Bun cold start ~23-26ms; a lean hook client (cold start + unix-socket connect + roundtrip) ~38-43ms; **the full `mcx` dev dispatch entry ~190ms.** A hook subprocess spawns *per tool call*. To hit CLAUDE.md's <50ms bar, `mcx hook` must be a **dedicated lean entry/binary with a minimal import graph**, NOT a subcommand routed through the main `mcx` dispatcher's import-heavy `main.ts`.

### Proposed decomposition (NOT one PR — see §10)

Ordered, each independently testable:
1. **stdio transport read/write plumbing behind a `transport` flag** (no permission change yet; run with `permissionMode: bypassPermissions` or `auto`-equivalent to prove parity).
2. **`mcx hook` lean binary + new IPC method `resolveHookPermission`** (daemon-side router/containment relocation).
3. **settings.json installer** (`~/.claude` + per-worktree, idempotent, cleanup).
4. **Per-turn `system/init` dedupe in the state machine.**
5. **Delete patcher/TLS/WS stack** (only after stdio is default and burned in).

Riskiest: **#2** (permission semantics + containment relocation + delegate timeout). Estimated confidence the overall migration is sound: **high (~85%)**; confidence it ships in one PR without regressions: **low (~15%)**.

---

## 1b. MVP framing (fixed permissions) — added per scope cut

**Decision:** for the first ship we do NOT need dynamic permission gating. Launch each `claude` process with a **fixed permission set decided at spawn time** (`--permission-mode` / `--allowedTools` / `--disallowedTools`, and `--dangerously-skip-permissions` for sandboxed sprint workers). The hard requirement is narrow: **send messages in, stream messages out, interrupt mid-turn.** That is exactly what the live probes already confirmed works on stdio.

**Does fixed-permission stdio unblock deleting the patcher and dropping `--sdk-url`? YES — verified.**
- The patcher's *only* purpose is rewriting the binary so `--sdk-url` passes claude's host allowlist (`strategies.ts:4-6,96-111`). Stdio mode never passes `--sdk-url`, so the patcher is dead weight for stdio sessions.
- PROBE §B: without `--sdk-url`, claude resolves permissions **locally** and never emits `can_use_tool`. With a fixed permission set, that is exactly the desired behavior — **no permission round-trip is needed at all**, so the entire hook/IPC machinery (decomp #B/#C) is deferred, not required.
- Nothing other than the `--sdk-url` WS transport depends on the patcher/TLS/WS stack; `session-state.ts` and `ndjson.ts` are transport-agnostic (§3.1). So going **stdio-only** (skip the A/B `transport` flag) lets us delete the whole stack immediately and run the latest unpatched `claude` — the §3.8 "net code goes up before it comes down" cost only applies if we keep A/B.

**MVP scope = decomp #A (stdio plumbing) + #D (init dedupe), plus two latent-bug fixes.** Defer #B (hook binary), #C (settings installer), containment relocation, delegate-timeout policy, and the `updatedInput` regression — all are part of *dynamic* permission gating (post-MVP).

**Live MVP risks, re-ranked** (the permission-gap crux and settings.json hazards drop out):
1. **Pipe-buffer deadlock at scale (Probe P2, §3.4).** Multi-session stdout drain was never tested >1 session. A single >64KB `tool_result` line on a non-drained pipe deadlocks the child. Mitigation is generalizing the existing `drainStderr` loop (ws-server.ts:2511), but N concurrent children needs a real load test. **This is the #1 MVP risk.**
2. **`session-state.ts` transport-agnosticism gaps (§3.1).** Three concrete breaks: repeated `system/init` per turn (Break 1 → that's why #D is in-scope), WS lifecycle methods (`reconnect`/`disconnect`) become dead in stdio (Break 2), and connect-timeout must rewire from "WS open event" to "first stdout line" (§3.5).
3. **Two latent bugs that bite MVP immediately (§3.1).** (a) `rate_limit_event` is unknown → spurious "unrecognized type" error log every turn. (b) `result/error_during_execution` lacks `errors[]` so it mis-parses as success-with-empty-result — **this is the interrupt result**, and interrupt is an MVP hard requirement, so an interrupted turn would wrongly emit `session:result` (empty) instead of `session:error`. **Fix (b) inside MVP**, not as a follow-up.

**Not needed for MVP:** `mcx hook` cold-start budget, daemon-down fail-closed behavior, delegate-timeout footgun, `updatedInput` rewrite regression, settings.json install/cleanup races. All deferred to the dynamic-permission phase (the long-term target preserved in §3.2/§3.6/§3.7 below).

---

## 2. Architecture map (verified)

```
                   ┌─────────────────────────── mcpd (daemon process) ──────────────────────────┐
                   │                                                                             │
                   │  claude-session-worker.ts (Worker thread)                                   │
                   │    startServer() → resolveClaudeForSpawn() → new ClaudeWsServer({...})       │
                   │      ws-server.ts (2661 lines)                                              │
                   │        prepareSession() → SessionState + PermissionRouter + ContainmentGuard │
                   │        spawnClaude()    → Bun.spawn([claude, --sdk-url, ...])                │
                   │        handleMessage()  → parseFrame() → state.handleMessage() → events      │
                   │        handlePermissionRequest() → containment → router.evaluate() → respond  │
                   │        sendToWs()       → ws.send(NDJSON)                                     │
                   │                                                                             │
                   └───────────▲──────────────────────────────────────┬──────────────────────────┘
                               │  WS frames (NDJSON)                   │  spawn
                  ws://localhost / wss://[::1]                          │
                               │                                       ▼
                   ┌───────────┴───────────────────────────────────────────────┐
                   │  claude CLI (patched, 2.1.120+)   --sdk-url <ws>            │
                   │   stdin: ignore   stdout: ignore   stderr: pipe(drain)      │
                   └────────────────────────────────────────────────────────────┘

  PROPOSED (stdio):
                   │        spawnClaude() → Bun.spawn([claude, --print, --input-format=stream-json,
                   │                                    --output-format=stream-json, --include-hook-events])
                   │        stdin: pipe   stdout: pipe(drain→parseLine→state)   stderr: pipe(drain)
                   │        sendToProc() → proc.stdin.write(NDJSON)
                   ▼
            ┌─────────────────────────────┐        PreToolUse hook (subprocess, per tool call)
            │ claude CLI (UNPATCHED)       │  ───►  mcx hook PreToolUse  ──IPC──►  mcpd
            │ stdin/stdout = control plane │  ◄───  {permissionDecision} ◄──────  resolveHookPermission
            └─────────────────────────────┘
```

---

## 3. Claim-by-claim verification against source + live binary

### 3.1 Is `session-state.ts` actually transport-agnostic? — **Mostly YES, with 3 spots that break**

`SessionState.handleMessage(msg: NdjsonMessage)` (session-state.ts:105-116) operates purely on parsed objects with no WS/socket awareness. `ndjson.ts` `parseLine`/`parseFrame`/`serialize` are pure string↔object. **The state machine itself ports cleanly.** But:

**Break 1 — repeated `system/init` per turn (PROBE §A confirms stdio re-emits init every turn).**
`applyInit` (session-state.ts:235-254) transitions `connecting→init` only once but **emits a `session:init` event unconditionally on every call**. Over WS, init arrives once per connection; over stdio it arrives **once per turn**. So a 10-turn stdio session emits 10 `session:init` events. The comment at line 240 ("don't regress state when the CLI reconnects after a WS drop and re-sends system/init") shows the author anticipated *some* re-emission, but the event still fires each time. Downstream consumers (`handleSessionEvent` → monitor events, work-item bindings, session-display) will see spurious `session:init`. **Fix:** dedupe by tracking `initEmitted` and suppressing the event after the first (or convert subsequent inits into a lighter `session:turn_boundary` event — useful signal, since the richer stdio init carries fresh `mcp_servers`/`slash_commands` state per turn).

**Break 2 — `reconnect()` / `disconnect()` / WS lifecycle methods have no stdio analog.**
`disconnect(reason)` (175), `reconnect()` (183), `resetForClear()` (188) model WS connection lifecycle. In stdio there is no "WS dropped but process alive" state — the only disconnect is **process exit (EOF/exit code)**. `reconnect()` (connecting after sleep/wake) is meaningless for stdio (the pipe doesn't survive a process restart). These methods stay in the API but several become dead in stdio mode; the *worker* (`ws-server.ts`) is where the lifecycle wiring actually lives and must branch.

**Break 3 — permission path is structurally WS-shaped.**
`handleControlRequest` (383-408) only fires on inbound `control_request/can_use_tool`. **PROBE §B confirms `can_use_tool` is NEVER emitted without `--sdk-url`** (claude resolves permissions locally). So in stdio mode `handleControlRequest` never runs, `pendingPermissions` stays empty, `state` never enters `waiting_permission`, and `respondToPermission` (137-161) is never called from the inbound path. The entire permission state-machine sub-graph goes dark and must be re-driven from the hook IPC handler. `respondToPermission`'s `state` transition logic (waiting_permission→active) would have to be invoked synthetically by the hook handler if the daemon still wants to expose pending-permission state to `mcx claude approve/deny`.

**Latent bugs surfaced (transport-independent, file separately):**
- `rate_limit_event` (a real 2.1.150 message type, captured in PROBE §A) is **not** in any schema and **not** in `KNOWN_MSG_TYPES` (ws-server.ts:82) → triggers the "Unrecognized message type … silently dropped" error log (ws-server.ts:1670) on *every* turn, on both transports.
- `result/subtype:"error_during_execution"` (the interrupt result, PROBE §F) has **no `errors[]` array**, so `ResultError` (ndjson.ts:117) fails to parse and it falls through to `ResultFallback` → emits `session:result` with empty string instead of `session:error`. Affects both transports.

### 3.2 The permission gap — the crux

**Current WS flow (synchronous-feeling, in-process):**
`handlePermissionRequest` (ws-server.ts:2018-2065):
1. `ContainmentGuard.evaluate(tool, input)` — **stateful, in-process** (strikes/escalation, containment.ts:281). Runs FIRST. Can deny + escalate.
2. If `strategy === "delegate"`: emit `SESSION_PERMISSION_BLOCKED`, **return (leave pending)**. A human later calls `claude_approve`/`claude_deny` → `respondToPermission` (worker:387/398) → `sendToWs(permissionAllow|Deny)`. Fully async, unbounded wait.
3. Else: `await router.evaluate(request)` (auto/rules), then `permissionAllow(requestId, decision.updatedInput ?? input)` or `permissionDeny`. **`updatedInput` can rewrite the tool call.**

**Proposed hook flow (PROBE §C/§E/§G):**
`claude` spawns `mcx hook PreToolUse` → POSTs `{session_id, tool_name, tool_input, ...}` to mcpd → daemon runs containment+router → returns decision → hook prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny|allow","permissionDecisionReason":"..."}}` → claude honors.

| Dimension | WS path (today) | Hook path (proposed) | Verdict |
|---|---|---|---|
| auto/rules eval | in-process, sub-ms | IPC roundtrip ~13ms (PROBE §H) + ~25ms subprocess cold start | +~40ms/tool. Acceptable for sprint workers, measurable at scale. |
| **`updatedInput` rewrite** | yes (ws-server.ts:2060) | **NO channel** (verified) | **Regression.** Audit whether any router rule actually mutates input today; if yes, this blocks. |
| containment (stateful) | in-process, runs first | must relocate to daemon, key by session_id, evaluate inside `resolveHookPermission` | Doable; the hook payload includes `session_id` (PROBE §C) so correlation works. |
| **delegate (human-in-loop)** | async, pend indefinitely | **blocking** up to hook timeout (default 600s; PROBE §E proves claude blocks) | **Behavior change.** Beyond timeout claude *cancels* and the tool proceeds (PROBE §D). For a >10min human, this is unsafe-by-default. Mitigation: long explicit `timeout` + on-cancel the daemon must treat as deny (but the cancelled hook already let the tool through — see §3.2.1). |
| daemon down/busy | session drops (visible) | **fail-closed deny** (PROBE §G: exit≠0 → tool blocked) | Safer default, but every tool stalls; worker can't progress. |
| matcher → per-tool gating | router sees every tool | matcher in settings.json (`"matcher":"Bash"` etc.) selects which tools invoke the hook | Use matcher `"*"` (or omit) to gate ALL tools, then dispatch in-daemon. Don't try to encode policy in matchers. |

#### 3.2.1 The delegate/timeout trap (subtle, important)
PROBE §D: hook with `timeout:5` sleeping 30s → `outcome:"cancelled"`, `exit_code:1`, then the **turn completed normally** (`is_error:false`, Stop hook fired). I could not definitively prove whether a *cancelled* PreToolUse hook **allows or abandons** the tool (the test model didn't reliably re-attempt). This is a **must-close empirical gap** (Probe P1 below): if a cancelled hook = allow, then a delegate that exceeds the timeout silently *grants* the permission — a security footgun. If = deny/abandon, delegate degrades safely. Design `mcx hook` to **block, then on its own internal deadline return an explicit deny** rather than letting claude's cancel decide.

### 3.3 PostToolUse / Stop / SessionEnd as NDJSON-event replacements
- **Stop** fires reliably and appears in the stream as `hook_started`/`hook_response` with `hook_event:"Stop"` (PROBE §A, even un-configured — my ambient settings had one). It is a viable turn-end signal but **the `result` message already gives that** (state machine → `session:result`). Stop is redundant for turn detection.
- **SessionEnd** payload confirmed (PROBE, dedicated run): `{session_id, transcript_path, cwd, hook_event_name, reason}` with `reason:"other"`. Useful as a clean teardown signal that complements `proc.exited`.
- **PostToolUse / UserPromptSubmit shapes NOT confirmed** — in repeated probes their hook subprocesses raced process teardown when stdin EOF'd, and on the held-open run the model didn't call a tool. **Residual gap** (Probe P3). They are *not* needed to replace the permission path (PreToolUse suffices); they'd only be needed if the daemon wants richer lifecycle events. **Recommend: do NOT take a dependency on PostToolUse/UserPromptSubmit/Stop for the core migration.** Tool-result and turn-result info already arrives via NDJSON `assistant`/`result` on stdout.

### 3.4 Mid-turn writes & pipe-buffer deadlock
- **Linux pipe buffer = 65536 bytes** (verified via `F_GETPIPE_SZ`). Captured `system/init` line ≈ 2.5KB.
- **Outbound (daemon→child stdin)**: only control messages — `user` prompts, `control_request/interrupt|set_model`. All tiny (<1KB). The child reads stdin between turns / on its own loop. **No realistic stdin backpressure.**
- **Inbound (child→daemon stdout)**: a single `tool_result` for a large file `Read` or a big `assistant` content block **can exceed 64KB on one line.** If the daemon's stdout reader is not continuously draining, the child blocks on `write()` mid-turn → classic deadlock. **Mitigation is the existing pattern:** `drainStderr` (ws-server.ts:2511-2536) is a `getReader()` loop that splits on `\n` and keeps a `partial` buffer. Generalize it to a `drainStdout` that, instead of pushing to `lines[]`, calls `parseLine` + `state.handleMessage` per complete line. Because Bun schedules the reader on the event loop and the daemon's outbound writes are async + tiny, deadlock is avoidable **IF the reader is started before the first write and never awaited synchronously inside the message dispatch.** At **N concurrent children** the risk is event-loop starvation: each worker thread hosts one ws-server; N children = N stdout readers competing. Must be load-tested (Probe P2 — POC never tested multi-session).
- **Head-of-line blocking**: stdin is a single ordered pipe. An `interrupt` queued behind a large prompt write is fine (prompts are tiny), but if the daemon ever streams large input (e.g. injecting file content as a user message), interrupt latency degrades. Keep injected user content small or chunk it.

### 3.5 Process lifecycle & failure modes

| Transition | WS today | stdio proposed | Fidelity |
|---|---|---|---|
| spawn | `Bun.spawn(stdin:ignore,stdout:ignore,stderr:pipe)` (ws-server.ts:851) | `stdin:pipe,stdout:pipe,stderr:pipe` | OK |
| connect/init | WS `open` event + `system/init` → state `init`; `connectTimer` kills if no WS in `CONNECT_TIMEOUT_MS` (ws-server.ts:868) | first stdout line `system/init`; **no WS open event** → connect-timeout must key off "first stdout line received" instead | Must rewire connect detection. |
| idle/active | `result`→idle, `assistant`/prompt→active | identical (NDJSON) | OK |
| waiting_permission | `control_request/can_use_tool`→waiting | **never happens**; permission is out-of-band via hook IPC | Lost on inbound; synthesize from hook handler if exposing pending state. |
| interrupted | `interrupt` control_request (ws-server.ts:164) | **same on stdin** (PROBE §F ✓) | OK |
| crashed | `proc.exited` + WS close (two signals) | `proc.exited` + stdout EOF (two signals) | OK; arguably cleaner (no WS-close-but-alive ambiguity). |
| killed | `proc.kill()` | same | OK |
| orphaned | `orphan-reaper.ts` on daemon startup; stuck-detector | same (orphan reaping is PID-based, transport-agnostic) | OK |
| hung child | `StuckDetector` (#1585) fed by `tool_progress`/`stream_event` progress (ws-server.ts:1664) | **same stream events arrive on stdout** | OK, but verify `tool_progress`/`stream_event` are emitted on stdio (they're in `IGNORED_TYPES` but used for progress; PROBE did not see them with haiku — Probe P4). |

`SIGINT` vs `control_request/interrupt`: today `interrupt` is the graceful in-band stop (ws-server.ts:164→`interruptRequest`); `proc.kill()` (SIGTERM) is teardown. Both unchanged on stdio. Note stdio gives a third option: **closing stdin (EOF)** signals "no more turns" — could replace `bye` for clean shutdown.

### 3.6 The `mcx hook` binary design (measured)
- **Cold-start budget**: see §1 risk 3. Lean entry ~40ms, full `mcx` ~190ms. **Build `mcx hook` as a separate compiled artifact or a top-of-`main.ts` fast path that short-circuits before importing the command graph.** `dist/` was not built in this env so I could not measure the *compiled* number; the dev numbers bound it from above.
- **Socket discovery**: `options.SOCKET_PATH` (constants) — `~/.mcp-cli/mcpd.sock`. `rawFetch` (ipc-client.ts:82) already encapsulates `{ unix: SOCKET_PATH }`. The hook can call `ipcCall` directly (ipc-client.ts:96) which does **NOT** auto-start. **Do not** use command/daemon-lifecycle's `sendRequest` (auto-starts). Set a tight `timeoutMs` (e.g. 5000ms, well under the hook's own timeout) so a hung daemon fails fast → deny.
- **Auth**: none needed — the Unix socket is the trust boundary (already the model for all `mcx call`).
- **New IPC method**: `resolveHookPermission` with params `{ sessionId, toolName, toolInput, toolUseId, cwd, hookEvent }` → result `{ decision: "allow"|"deny"|"ask", reason?: string }`. The daemon routes to the right worker (the `_claude` server hosts sessions in a worker thread — the IPC handler must forward to the worker, mirroring how `claude_approve` reaches `respondToPermission` via the worker, worker:387). Add to `IpcMethod` (ipc.ts:19), `IpcMethodResult` (ipc.ts:838), and a handler in `packages/daemon/src/handlers/`.
- **Failure contract** (PROBE §G): exit≠0 / no-JSON → claude denies the tool. So `mcx hook` should **on any error print an explicit deny JSON** (not just exit 1) to make the reason visible in the stream, AND exit 0 so the `outcome` is `success` not `error`.

### 3.7 settings.json installation hazards
- **`~/.claude/settings.json` is the user's real config.** Auto-mutating it risks: collision with the user's existing `PreToolUse` hooks (claude runs ALL matching hooks; multiple hooks each get the payload and any deny wins), non-idempotent re-writes, and orphaned hook entries after uninstall. **Use per-cwd `.claude/settings.json` (or `.claude/settings.local.json`) scoped to the worktree** for sprint workers — claude merges project + user settings, and the worktree file is disposable with the worktree. Avoid touching `~/.claude` at all for the autonomous-worker case.
- **Per-worktree races**: parallel sprint workers each get a distinct worktree (`worktree-commands`, ws-server.ts:1188 notes parallel-spawn worktree collision #1836). The hook settings file lives *inside* the worktree, so writes don't race across workers — **but** the daemon must write it **before spawn** (`prepareSession`/`spawnClaude` is the natural point; `repoRoot`/`cwd` are in `SessionConfig`, ws-server.ts:104/113). Idempotency: write-if-absent-or-managed-block (use a sentinel comment / managed key) so re-spawns don't duplicate.
- **Cleanup**: tie removal to worktree teardown (line 112 already captures `repoRoot` "for worktree hook config lookup at teardown" — that hook-config-teardown machinery partially exists). For the rare `~/.claude` install, must be reversible.
- **Footgun**: the hook command path must be **absolute** (settings.json doesn't resolve PATH reliably in `-p` mode where settings validation is silent — see `--print` help text: "Settings files that fail validation are silently ignored"). A bad hook path = silently no gating = unsupervised worker. **Validate the installed settings parse before relying on them.**

### 3.8 The A/B `transport` config flag — blast radius
Keeping `sdk-url` alive during rollout means **keeping the entire patcher + TLS + WS stack** (14 files touch it: `binary-resolver.ts`, `claude-patch/*`, `tls/self-signed.ts`, `constants.ts` TLS/PATCHED dirs, `claude.ts` `patch-update` subcommand, both worker + ws-server). So **net code goes UP before it goes down** — the A/B period roughly doubles the spawn/transport surface. The flag belongs in `SessionConfig` (ws-server.ts:96) and/or `~/.mcp-cli/config.json`, defaulting to `sdk-url` initially, flipping to `stdio` after burn-in, then deleting `sdk-url`. **Rollback** is config-only (good). **Migration**: an in-flight WS session can't be migrated to stdio (different process invocation) — the flag takes effect on next spawn only.

### 3.9 Test parity
- **`ws-server.spec.ts` (212 tests)** — the dominant suite. Most drive `prepareSession`/`handleMessage`/`sendPrompt` with an **injected `SpawnFn`** (ws-server.ts:223, `defaultSpawn` is DI-overridable) and feed synthetic NDJSON. These are **transport-agnostic and largely survive**, but tests asserting WS `open`/`send`/`close` behavior, `wss://`/`ws://` URL assembly (spawnClaude:792), and the keep-alive timer need stdio analogs (stdout-reader-driven). The injected spawn must grow `stdin`/`stdout` mock streams.
- **`ws-server-tls.spec.ts` (10) + `binary-resolver.spec.ts` (10) + `patcher.spec.ts` (33) + `self-signed.spec.ts` + `strategies.spec.ts`** — **deleted** with the stack (~60+ tests). Coverage ratchet (CLAUDE.md) means the new stdio-drain + hook-handler + settings-installer code must add tests to hold the line.
- **Mock path exists**: `mock-server.ts`/`mock-session-worker.ts` provide a claude-free session path — usable to test the daemon-side hook IPC handler without a real binary. But **end-to-end stdio + real PreToolUse hook can only be tested with a real `claude`** (as done here). Gate such tests on binary presence (like `MCX_CLAUDE_BINARY`).

---

## 4. Empirical probe log (claude 2.1.150, Linux x86_64)

| # | Probe | Result | Confirms |
|---|---|---|---|
| §A | stdio multi-turn: feed 2 user msgs to one process | EXIT=0 after both; `init`×2, `result`×2, **1 distinct session_id**; results "ONE","TWO" | Process persists; init re-emits per turn; same session |
| §B | run without `--sdk-url` | no `can_use_tool` ever emitted | Permission resolved locally — the gap is real |
| §C | PreToolUse hook on `matcher:"Bash"` | hook stdin = `{session_id,transcript_path,cwd,permission_mode,hook_event_name,tool_name,tool_input,tool_use_id}`; returning `permissionDecision:"deny"` → tool denied | Hook gating works; payload has session_id for correlation |
| §D | hook `timeout:5`, sleeps 30 | `outcome:"cancelled"`, `exit_code:1`, turn still completed | Claude cancels slow hooks at timeout (does not hang) |
| §E | hook `timeout:60`, sleeps 8 | claude blocked full 8s (`duration_ms:11971`) | Claude synchronously blocks on hook → delegate feasible, bounded by timeout |
| §F | `set_model` + `interrupt` control_requests on stdin | both `control_response/success` w/ matching request_id; interrupt → `result/error_during_execution`,`is_error:true` | interrupt+set_model verbatim on stdin |
| §G | hook exits 1, no JSON (daemon-down sim) | `outcome:"error"`, **tool BLOCKED** (file not created) | Fail-closed deny on hook failure |
| §H | latency | trivial bun ~24ms; lean hook client ~40ms total / ~13ms roundtrip; full `mcx` dev ~190ms | Cold-start budget — lean binary required |
| extra | `system/init` richness | carries `mcp_servers, slash_commands, agents, skills, plugins, output_style, startup_timing` | Richer than WS init (POC claim ✓) |

---

## 5. Unknowns the POC (and this analysis) did not close — concrete probes

- **P1 (security-critical):** Does a **cancelled** PreToolUse hook (timeout exceeded) **allow or abandon** the tool? Probe: hook that `sleep`s past a 3s timeout, then check via a side-effect tool (Write a marker) whether the tool actually ran. Design `mcx hook` to self-deadline + explicit-deny regardless.
- **P2 (scale):** Multi-session stdout drain under load. Probe: spawn 8-16 concurrent stdio claude children each emitting a >64KB `tool_result` (large file Read), confirm no deadlock and bounded latency. POC never tested >1 session.
- **P3:** PostToolUse / UserPromptSubmit hook payload shapes (raced teardown here). Probe: held-open stdin, ensure the model calls a tool, capture to file with `sync`.
- **P4:** Are `tool_progress` / `stream_event` emitted on stdio? (Needed for `StuckDetector`.) Probe: a long-running Bash tool with `--include-partial-messages`.
- **P5:** `result/error_during_execution` shape across more triggers (no `errors[]` confirmed for interrupt) — does `ResultFallback` always catch it? Add a strict schema variant.
- **P6:** Compiled `mcx hook` cold start (couldn't build `dist/` here). Probe: `bun build --compile` the lean entry, measure.

---

## 6. Decomposition into shippable issues (challenge: NOT one PR)

```
#A stdio transport plumbing ──► #B mcx hook + resolveHookPermission ──► #C settings installer
        │                              │                                      │
        ▼                              ▼                                      ▼
   #D init dedupe              (containment relocation                  (worktree teardown
   (independent)                + delegate timeout policy)               cleanup, idempotency)
        └──────────────┬──────────────┴──────────────────┬───────────────────┘
                       ▼                                  ▼
                  #E flip default to stdio (A/B) ──► #F delete patcher/TLS/WS stack
```

1. **#A — stdio read/write behind `transport` flag.** Generalize `drainStderr`→`drainStdout(→parseLine→state)`; add `sendToProc(stdin.write)`; flip spawn args (`--print --input-format/--output-format=stream-json --include-hook-events`, drop `--sdk-url`); rewire connect-timeout to first-stdout-line. Test with injected spawn + mock stdout stream and (gated) real binary in `auto`/bypass mode. **Independently testable; no permission change.**
2. **#B — `mcx hook` lean binary + `resolveHookPermission` IPC + daemon-side containment/router relocation.** Riskiest. Includes the delegate-timeout policy decision (block-with-deadline, explicit deny). Document the `updatedInput` regression and audit current rule usage.
3. **#C — settings.json installer** (per-worktree first; `~/.claude` only if needed), idempotent managed-block, validate-on-write, teardown cleanup (extend the existing line-112 teardown lookup).
4. **#D — per-turn `system/init` dedupe** in `session-state.ts` (small, independent, also helps WS resilience).
5. **#E — flip `transport` default to stdio**, burn-in window.
6. **#F — delete** `claude-patch/*`, `binary-resolver.ts`, `tls/self-signed.ts`, TLS/PATCHED constants, `patch-update` CLI, `NODE_TLS_REJECT_UNAUTHORIZED`, `~/.mcp-cli/tls`+`claude-patched` dirs, ~60 tests. Only after #E is stable.
- **Side issues to file now:** `rate_limit_event` unhandled (both transports); `error_during_execution` schema gap; `mcx hook` cold-start budget needs a lean entry.

---

## 7. Appendix — key file:line index

- Spawn args & transport URL: `ws-server.ts:792-808` (`--sdk-url`, `wss://[::1]`/`ws://localhost`), env `NODE_TLS_REJECT_UNAUTHORIZED` at `:848-850`, spawn opts (stdin:ignore,stdout:ignore,stderr:pipe) `:851-857`.
- Inbound dispatch: `ws-server.ts:1634-1702` (`handleMessage`→`parseFrame`→`state.handleMessage`).
- Outbound: `ws-server.ts:2296-2311` (`sendToWs`); prompt path `:963-994`.
- Permission gating: `ws-server.ts:2018-2065` (containment-first, delegate-return, router.evaluate, `permissionAllow(updatedInput)`).
- stderr drain (generalizable): `ws-server.ts:2511-2536`.
- DI spawn shape: `ws-server.ts:223-237`, `defaultSpawn` `:2622-2640`.
- State machine: `session-state.ts` (init `:212-254`, control_request `:383-408`, lifecycle `:175-208`).
- Wire schemas/serializers: `ndjson.ts` (CanUseTool `:149-165`, HookCallback `:167-176`, InitializeRequest.hooks `:255-267`, set_model `:443-449`).
- PermissionRouter: `permission-router.ts:40-69` (auto/rules/delegate).
- ContainmentGuard: `containment.ts:281-361` (stateful strikes/escalate).
- Patcher stack (delete): `claude-patch/patcher.ts`, `strategies.ts`; resolver `binary-resolver.ts:95-181`; TLS `tls/self-signed.ts`; dirs `constants.ts:134-136`.
- IPC: `ipc.ts:19` (`IpcMethod`), `:838` (`IpcMethodResult`); client `ipc-client.ts:82` (`rawFetch`/unix socket), `:96` (`ipcCall`, no auto-start); auto-start wrapper `daemon-lifecycle.ts:161` (avoid in hook).
- Worker hosting: `claude-session-worker.ts:704-769` (startServer/resolution), permission relay `:387/:398`.
- Tests: `ws-server.spec.ts` (212), `ws-server-tls.spec.ts` (10), `binary-resolver.spec.ts` (10), `patcher.spec.ts` (33).
