/**
 * Session state machine for Claude Code WebSocket SDK sessions.
 *
 * Processes inbound NDJSON messages from the CLI, tracks session metadata
 * (model, cwd, cost, tokens, pending permissions), and produces typed events
 * for the WS server / virtual-server layer to observe.
 */

import type { SessionStateEnum } from "@mcp-cli/core";
import type {
  AssistantFallback as AssistantFallbackMsg,
  Assistant as AssistantMsg,
  CanUseTool as CanUseToolMsg,
  NdjsonMessage,
} from "./ndjson";
import {
  AssistantFallback,
  Assistant as AssistantSchema,
  CanUseTool as CanUseToolSchema,
  ResultError,
  ResultFallback,
  ResultSuccess,
  SystemInit,
  SystemInitFallback,
  SystemPermissionDenied,
  interruptRequest,
  permissionAllow,
  permissionDeny,
  userMessage,
} from "./ndjson";
import type { SessionTransport } from "./transport-resolver";

// ── Events emitted by handleMessage ──

export type SessionEvent =
  | { type: "session:init"; sessionId: string; model: string; cwd: string; state: SessionStateEnum }
  | { type: "session:response"; message: AssistantMsg }
  | { type: "session:permission_request"; requestId: string; request: CanUseToolMsg["request"] }
  | {
      type: "session:permission_denied";
      toolName: string;
      toolUseId?: string;
      reasonType?: string;
      reason?: string;
    }
  | { type: "session:result"; cost: number; tokens: number; numTurns: number; result: string }
  | { type: "session:error"; errors: string[]; cost: number }
  | { type: "session:rate_limited"; sessionId: string; retryAfterMs?: number }
  | { type: "session:disconnected"; reason: string }
  | { type: "session:ended" }
  | { type: "session:cleared" }
  | { type: "session:model_changed"; model: string }
  | { type: "session:containment_warning"; toolName: string; reason: string; strikes: number }
  | { type: "session:containment_denied"; toolName: string; reason: string; strikes: number }
  | { type: "session:containment_escalated"; toolName: string; reason: string; strikes: number }
  | { type: "session:containment_reset"; toolName: string; reason: string; strikes: number };

// ── Result-suppression diagnostics (#2859) ──

/** Which branch of handleResult() suppressed a replayed result. */
export type SuppressedResultBranch = "result" | "error" | "fallback";

/**
 * Recorded when handleResult()'s idempotency guard drops a replayed
 * result/error. Read by the caller to emit a debug log + metric so an
 * over-firing guard is diagnosable instead of a silent hang.
 */
export interface SuppressedResultInfo {
  branch: SuppressedResultBranch;
  numTurns: number;
  lastEmitted: number;
}

// ── Outbound message (string ready to send over WS) ──

export type OutboundMessage = string;

// ── Request ID generation ──

export type RequestIdGenerator = () => string;

function createDefaultIdGenerator(): RequestIdGenerator {
  let nextId = 1;
  return () => `mcpd-${nextId++}`;
}

/**
 * How long a rate-limit signal counts as "currently throttled" when the CLI
 * gives no `retry_after` hint. Bounded on purpose: an unbounded flag is the
 * #3104 bug, and an over-long guess is indistinguishable from it to a reader
 * of `mcx claude ls`. A minute outlives a transient 429 and is short enough
 * that a session which is actually working stops being described as blocked.
 */
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

// ── Ignored message types ──

export const IGNORED_TYPES: ReadonlySet<string> = new Set([
  "keep_alive",
  "stream_event",
  "tool_progress",
  "tool_use_summary",
  "auth_status",
]);

// ── Session state machine ──

export class SessionState {
  readonly sessionId: string;
  state: SessionStateEnum;
  model: string | null = null;
  cwd: string | null = null;
  cost = 0;
  tokens = 0;
  numTurns = 0;
  readonly pendingPermissions = new Map<string, CanUseToolMsg["request"]>();
  lastToolCall: { name: string; errorMessage?: string; at: number } | null = null;
  hasActiveToolCall = false;
  private readonly genRequestId: RequestIdGenerator;

  /**
   * Set to true when the last handleMessage used a fallback schema instead
   * of the strict one. Cleared on every handleMessage call. Allows callers
   * (ws-server) to log diagnostics without the state machine needing a logger.
   */
  parseMismatch = false;

  /**
   * Set when handleResult()'s num_turns idempotency guard (#2837) suppressed a
   * replayed result/error at one of its `return []` points. Cleared on every
   * handleMessage call, like parseMismatch. The caller (ws-server) reads it to
   * emit a debug log + increment `mcpd_session_result_suppressed_total` so an
   * over-firing guard is not invisible in production — a swallowed completion
   * would otherwise be indistinguishable from a hung session (#2859).
   */
  suppressedResult: SuppressedResultInfo | null = null;

  /**
   * True after the first `session:init` event has been emitted. Subsequent
   * `system/init` messages (stdio re-emits one every turn) still update
   * model/cwd but suppress the event to avoid downstream noise.
   */
  private initEmitted = false;

  /**
   * num_turns of the last emitted `session:result`/`session:error` event.
   * Within one work cycle a replayed historical `result` (WS-reconnect /
   * revive replay) carries a non-increasing value and is suppressed (#2837).
   *
   * The baseline is reset by:
   *   - resetForClear() — a /clear respawns a fresh conversation whose
   *     num_turns restarts at 1.
   *   - promptDelivered(), on the **stdio transport only** — over stdio
   *     `--print` every turn reports num_turns=1, so num_turns is not a
   *     monotonic key there and without the reset the guard suppressed
   *     `session:result` on every follow-up and `mcx claude send --wait` hung
   *     forever (#3003).
   *
   * NOT reset for a new prompt on ws: num_turns IS cumulative there, so the
   * baseline stays meaningful across turns. Dropping it would re-open #2837
   * case B — a disconnect()+reconnect() replay while a prompt is pending would
   * re-emit the PREVIOUS turn's result and resolve the `--wait` waiter with a
   * stale answer while the real turn is still running.
   *
   * NOT reset in reconnect(): a reconnect is the same conversation and skips
   * the initial message (handleOpen sends it only on fresh connections), so a
   * replayed result there must still be suppressed (#2837).
   *
   * Scope: this dedup is per-instance and does NOT survive a daemon restart —
   * restoreSessions() builds a fresh SessionState (lastEmittedNumTurns=-1) and
   * does not restore it, so a post-restart revive replay can re-emit once.
   * Persisting it across restart is tracked in #2860.
   */
  private lastEmittedNumTurns = -1;

  /**
   * Transport this session's CLI process speaks. Only `stdio` restarts
   * num_turns at 1 on every turn; `ws` keeps it cumulative. Read solely by
   * promptDelivered() to scope the dedup-baseline reset.
   */
  private readonly transport: SessionTransport;

  /** Clock, injectable so rate-limit expiry is testable without waiting (#3104). */
  private readonly now: () => number;

  /** Epoch ms of the most recent rate-limit signal. Null when none is outstanding. */
  private rateLimitedAtMs: number | null = null;
  /** Epoch ms the outstanding signal stops counting as "currently throttled". */
  private rateLimitUntilMs = 0;
  /** Signals behind the outstanding flag — reported so `×3` can replace a bare badge. */
  private rateLimitSignals = 0;

  constructor(
    sessionId: string,
    genRequestId?: RequestIdGenerator,
    transport: SessionTransport = "ws",
    now: () => number = Date.now,
  ) {
    this.sessionId = sessionId;
    this.state = "connecting";
    this.genRequestId = genRequestId ?? createDefaultIdGenerator();
    this.transport = transport;
    this.now = now;
  }

  /**
   * Whether the session is throttled **right now** — i.e. a rate-limit signal
   * arrived, its retry window has not elapsed, and nothing has demonstrated
   * progress since.
   *
   * Before #3104 this was a plain field set on any rate-limit signal and
   * cleared only by a successful `result`, so one transient signal in the first
   * seconds of a 15-minute turn rendered `[RATE LIMITED]` for the whole turn on
   * a session that was producing tokens the entire time. The flag is
   * load-bearing — orchestrators read `mcx claude ls` to decide whether a worker
   * is stalled — and it only ever erred toward "throttled", which invites
   * exactly the wrong intervention (back off, restart, stop the sprint).
   */
  get rateLimited(): boolean {
    return this.rateLimitedAtMs !== null && this.now() < this.rateLimitUntilMs;
  }

  /** Epoch ms of the signal behind `rateLimited`, or null when not rate-limited. */
  get rateLimitedAt(): number | null {
    return this.rateLimited ? this.rateLimitedAtMs : null;
  }

  /** Rate-limit signals behind `rateLimited` (0 when clear, ≥1 while set). */
  get rateLimitHits(): number {
    return this.rateLimited ? this.rateLimitSignals : 0;
  }

  /**
   * Process an inbound NDJSON message from the CLI.
   * Returns zero or more events for observers.
   */
  handleMessage(msg: NdjsonMessage): SessionEvent[] {
    this.parseMismatch = false;
    this.suppressedResult = null;
    if (IGNORED_TYPES.has(msg.type)) return [];
    if (msg.type === "system" && msg.subtype === "status") return [];

    if (msg.type === "system" && msg.subtype === "permission_denied") return this.handlePermissionDenied(msg);

    if (msg.type === "system" && msg.subtype === "init") return this.handleInit(msg);
    if (msg.type === "assistant") return this.handleAssistant(msg);
    if (msg.type === "result") return this.handleResult(msg);
    if (msg.type === "control_request") return this.handleControlRequest(msg);
    if (msg.type === "rate_limit_event") return this.handleRateLimitEvent(msg);

    return [];
  }

  /** Build a user message to send to the CLI. */
  queuePrompt(message: string): OutboundMessage {
    if (this.state === "waiting_permission") {
      throw new Error("Cannot send prompt while waiting for permission approval");
    }
    if (this.state === "disconnected") {
      throw new Error("Cannot send prompt to disconnected session");
    }
    if (this.state === "ended") {
      throw new Error("Cannot send prompt to ended session");
    }
    // After sending a prompt, session becomes active
    if (this.state === "idle" || this.state === "init") {
      this.state = "active";
    }
    return userMessage(message, this.sessionId);
  }

  /**
   * Record that the message built by queuePrompt() actually reached the CLI.
   *
   * Called by the caller AFTER a successful transport write — never before,
   * because a failed write leaves no new turn running and must not disturb the
   * dedup baseline (ws-server throws on write failure, #3003).
   *
   * On stdio this starts a new work cycle whose result reports num_turns=1
   * again, so the #2837 baseline has to drop. On ws num_turns stays cumulative
   * and the baseline is left alone — see lastEmittedNumTurns.
   */
  promptDelivered(): void {
    if (this.transport === "stdio") this.lastEmittedNumTurns = -1;
  }

  /** Build a permission response for a pending can_use_tool request. */
  respondToPermission(requestId: string, allow: boolean, message?: string): OutboundMessage {
    const request = this.pendingPermissions.get(requestId);
    if (!request) {
      throw new Error(`No pending permission request with id ${requestId}`);
    }
    this.pendingPermissions.delete(requestId);

    // If no more pending permissions, transition back to active
    if (this.pendingPermissions.size === 0) {
      this.state = "active";
    }

    if (allow) {
      return permissionAllow(requestId, request.input);
    }
    const denyMessage = message ?? "Denied by session controller";
    if (this.lastToolCall && request.tool_name === this.lastToolCall.name) {
      // errorMessage only captures permission denials. MCP tool execution errors
      // (e.g. tool throws, non-zero exit) are not visible at the NDJSON layer —
      // they flow through the MCP transport in server-pool and would need separate
      // wiring to surface here (tracked in #1585 follow-up).
      this.lastToolCall.errorMessage = denyMessage;
    }
    return permissionDeny(requestId, denyMessage);
  }

  /** Build an interrupt control request. */
  interrupt(): OutboundMessage {
    if (this.state === "disconnected") {
      throw new Error("Cannot interrupt disconnected session");
    }
    if (this.state === "ended") {
      throw new Error("Cannot interrupt ended session");
    }
    return interruptRequest(this.genRequestId());
  }

  /** Mark the session as disconnected (WS dropped or spawn exited, but not bye'd). */
  disconnect(reason: string): SessionEvent[] {
    if (this.state === "ended" || this.state === "disconnected") return [];
    this.state = "disconnected";
    this.pendingPermissions.clear();
    return [{ type: "session:disconnected", reason }];
  }

  /** Transition from disconnected back to connecting (WS reconnected after sleep/wake). */
  reconnect(): void {
    if (this.state !== "disconnected") return;
    this.state = "connecting";
    this.initEmitted = false;
  }

  /** Reset state for a /clear (kill+respawn). Preserves cumulative cost/tokens. */
  resetForClear(): SessionEvent[] {
    if (this.state === "ended") return [];
    this.state = "connecting";
    this.initEmitted = false;
    // /clear respawns a fresh conversation whose num_turns restarts at 1;
    // that first post-clear result is legitimate and must not be suppressed.
    this.lastEmittedNumTurns = -1;
    this.pendingPermissions.clear();
    this.clearRateLimit();
    return [{ type: "session:cleared" }];
  }

  /** Update the tracked model (from /model command). */
  setModel(model: string): SessionEvent[] {
    this.model = model;
    return [{ type: "session:model_changed", model }];
  }

  /** Mark the session as ended (explicit bye or server shutdown). */
  end(): SessionEvent[] {
    if (this.state === "ended") return [];
    this.state = "ended";
    this.pendingPermissions.clear();
    return [{ type: "session:ended" }];
  }

  // ── Private handlers ──

  /**
   * The child denied a tool call on its own — auto-mode classifier block or a
   * settings deny rule (#3119). No `can_use_tool` round-trip happens for these,
   * so without this the daemon sees nothing at all: the session just keeps
   * running with a tool it silently cannot use, which reads exactly like a
   * worker thinking hard. Surface it as an event so it reads as a signal.
   *
   * Deliberately not a state transition — the child tells the model to carry on
   * with anything that doesn't depend on the denied call, so the session is
   * still active.
   */
  private handlePermissionDenied(msg: NdjsonMessage): SessionEvent[] {
    const parsed = SystemPermissionDenied.safeParse(msg);
    if (!parsed.success) {
      this.parseMismatch = true;
      return [];
    }
    const d = parsed.data;
    return [
      {
        type: "session:permission_denied",
        toolName: d.tool_name,
        ...(d.tool_use_id !== undefined && { toolUseId: d.tool_use_id }),
        ...(d.decision_reason_type !== undefined && { reasonType: d.decision_reason_type }),
        // Prefer the short machine-ish reason; the long `message` is guidance
        // aimed at the model, not at whoever is watching the event stream.
        ...(d.decision_reason !== undefined && { reason: d.decision_reason }),
      },
    ];
  }

  private handleInit(msg: NdjsonMessage): SessionEvent[] {
    const strict = SystemInit.safeParse(msg);
    if (strict.success) {
      return this.applyInit(strict.data.session_id, strict.data.model, strict.data.cwd);
    }

    // Fallback: extract what we can so the session doesn't stay stuck in "connecting"
    const loose = SystemInitFallback.safeParse(msg);
    if (loose.success) {
      this.parseMismatch = true;
      return this.applyInit(
        loose.data.session_id ?? this.sessionId,
        loose.data.model ?? "unknown",
        loose.data.cwd ?? "/",
      );
    }

    // unreachable: SystemInitFallback only requires type:"system" + subtype:"init",
    // both already confirmed by dispatch. Kept as defensive last resort.
    this.parseMismatch = true;
    return this.applyInit(this.sessionId, "unknown", "/");
  }

  private applyInit(sessionId: string, model: string, cwd: string): SessionEvent[] {
    this.model = model;
    this.cwd = cwd;

    // Only transition to "init" from "connecting" — don't regress state
    // when the CLI reconnects after a WS drop and re-sends system/init.
    if (this.state === "connecting") {
      this.state = "init";
    }

    // Stdio re-emits system/init every turn. Suppress the event after the
    // first to avoid spurious downstream noise (model/cwd are still updated).
    if (this.initEmitted) {
      return [];
    }
    this.initEmitted = true;

    return [
      {
        type: "session:init",
        sessionId,
        model,
        cwd,
        state: this.state,
      },
    ];
  }

  private handleAssistant(msg: NdjsonMessage): SessionEvent[] {
    const strict = AssistantSchema.safeParse(msg);
    if (strict.success) {
      this.state = "active";
      const usage = strict.data.message.usage;
      this.tokens += usage.input_tokens + usage.output_tokens;
      this.extractLastToolCall(strict.data.message.content);
      const events: SessionEvent[] = [{ type: "session:response", message: strict.data }];
      if (strict.data.error === "rate_limit") {
        const retryAfterMs = this.noteRateLimit(msg);
        events.push({ type: "session:rate_limited", sessionId: this.sessionId, retryAfterMs });
      } else {
        // The model just produced output: whatever throttling the last signal
        // described is over, whether or not its retry window has lapsed (#3104).
        this.clearRateLimit();
      }
      return events;
    }

    // Fallback: still transition to active and extract tokens if possible
    const loose = AssistantFallback.safeParse(msg);
    if (loose.success) {
      this.parseMismatch = true;
      this.state = "active";
      const usage = loose.data.message?.usage;
      if (usage) {
        this.tokens += usage.input_tokens + usage.output_tokens;
      }
      this.extractLastToolCallRaw(msg);
      const assistant = buildFallbackAssistant(msg, loose.data);
      const events: SessionEvent[] = [{ type: "session:response", message: assistant }];
      if (assistant.error === "rate_limit") {
        const retryAfterMs = this.noteRateLimit(msg);
        events.push({ type: "session:rate_limited", sessionId: this.sessionId, retryAfterMs });
      } else {
        this.clearRateLimit();
      }
      return events;
    }

    // Even the fallback failed — still transition to active
    // unreachable: AssistantFallback only requires type:"assistant", already confirmed by dispatch
    this.parseMismatch = true;
    this.state = "active";
    return [{ type: "session:response", message: buildFallbackAssistant(msg) }];
  }

  private handleResult(msg: NdjsonMessage): SessionEvent[] {
    this.hasActiveToolCall = false;
    const successResult = ResultSuccess.safeParse(msg);
    if (successResult.success) {
      const r = successResult.data;
      this.cost = r.total_cost_usd;
      this.numTurns = r.num_turns;
      // Don't add result usage to tokens — assistant messages already accumulate
      // per-message usage throughout the turn. Result usage would double-count.
      this.state = "idle";
      this.clearRateLimit();
      if (this.numTurns <= this.lastEmittedNumTurns) {
        this.suppressedResult = {
          branch: "result",
          numTurns: this.numTurns,
          lastEmitted: this.lastEmittedNumTurns,
        };
        return [];
      }
      this.lastEmittedNumTurns = this.numTurns;
      return [
        {
          type: "session:result",
          cost: this.cost,
          tokens: this.tokens,
          numTurns: this.numTurns,
          result: r.result,
        },
      ];
    }

    const errorResult = ResultError.safeParse(msg);
    if (errorResult.success) {
      const r = errorResult.data;
      this.cost = r.total_cost_usd;
      this.numTurns = r.num_turns;
      this.state = "idle";
      // The turn is over either way — an errored turn left the flag latched
      // forever before #3104, since only the success branch cleared it.
      this.clearRateLimit();
      if (this.numTurns <= this.lastEmittedNumTurns) {
        this.suppressedResult = {
          branch: "error",
          numTurns: this.numTurns,
          lastEmitted: this.lastEmittedNumTurns,
        };
        return [];
      }
      this.lastEmittedNumTurns = this.numTurns;
      return [{ type: "session:error", errors: r.errors ?? [], cost: this.cost }];
    }

    // Fallback: transition to idle for any result message, even if neither
    // strict schema matched. This prevents sessions from getting stuck in
    // "active" state when the CLI wire format drifts. Extract what we can.
    const fallback = ResultFallback.safeParse(msg);
    if (fallback.success) {
      this.parseMismatch = true;
      const r = fallback.data;
      // total_cost_usd and num_turns are cumulative — assign, don't add.
      // Only fall back to += when the field is missing (0), since we can't
      // tell if 0 means "zero cost" or "field absent".
      if (r.total_cost_usd != null) this.cost = r.total_cost_usd;
      if (r.num_turns != null) this.numTurns = r.num_turns;
      this.state = "idle";

      // Only dedup when the message actually carried num_turns. If it's absent
      // (ResultFallback.num_turns is optional), this.numTurns still holds the
      // PRIOR turn's value == lastEmittedNumTurns, so the guard would wrongly
      // suppress a genuine completion — a silent hang, since session:result is
      // the sole driver of workCompleted / waiter resolution. Fail open (#2837).
      if (r.num_turns != null) {
        if (this.numTurns <= this.lastEmittedNumTurns) {
          this.suppressedResult = {
            branch: "fallback",
            numTurns: this.numTurns,
            lastEmitted: this.lastEmittedNumTurns,
          };
          return [];
        }
        this.lastEmittedNumTurns = this.numTurns;
      }

      const errors = r.errors ?? [];
      if (r.subtype !== "success" && (r.is_error === true || errors.length > 0)) {
        return [{ type: "session:error", errors, cost: this.cost }];
      }
      return [
        {
          type: "session:result",
          cost: this.cost,
          tokens: this.tokens,
          numTurns: this.numTurns,
          result: r.result ?? "",
        },
      ];
    }

    // unreachable: ResultFallback only requires type:"result", already confirmed by dispatch
    return [];
  }

  private extractLastToolCall(content: Record<string, unknown>[]): void {
    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i];
      if (block.type === "tool_use" && typeof block.name === "string") {
        this.lastToolCall = { name: block.name, at: Date.now() };
        this.hasActiveToolCall = true;
        return;
      }
    }
    this.hasActiveToolCall = false;
  }

  private extractLastToolCallRaw(msg: NdjsonMessage): void {
    const rawMsg = (msg as Record<string, unknown>).message as Record<string, unknown> | undefined;
    if (!rawMsg) return;
    const content = rawMsg.content;
    if (!Array.isArray(content)) return;
    this.extractLastToolCall(content as Record<string, unknown>[]);
  }

  private handleControlRequest(msg: NdjsonMessage): SessionEvent[] {
    // Only handle can_use_tool control requests
    const parsed = CanUseToolSchema.safeParse(msg);
    if (!parsed.success) {
      // Flag if this looked like a can_use_tool but didn't parse — callers
      // can log the mismatch. Other control_request subtypes (hook_callback,
      // initialize, interrupt) are intentionally ignored here.
      const request = msg.request as Record<string, unknown> | undefined;
      if (request?.subtype === "can_use_tool") {
        this.parseMismatch = true;
      }
      return [];
    }

    const { request_id, request } = parsed.data;
    this.pendingPermissions.set(request_id, request);
    this.state = "waiting_permission";

    return [
      {
        type: "session:permission_request",
        requestId: request_id,
        request,
      },
    ];
  }

  private handleRateLimitEvent(msg: NdjsonMessage): SessionEvent[] {
    const retryAfterMs = this.noteRateLimit(msg);
    return [{ type: "session:rate_limited", sessionId: this.sessionId, retryAfterMs }];
  }

  /**
   * Record a rate-limit signal and start (or extend) its retry window.
   * Returns the parsed `retryAfterMs` so callers can carry it on the event.
   */
  private noteRateLimit(msg: NdjsonMessage): number | undefined {
    const retryAfterMs = extractRetryAfterMs(msg);
    // A signal arriving after the previous window lapsed starts a fresh count —
    // `×N` should describe the current episode, not the session's whole history.
    if (!this.rateLimited) this.rateLimitSignals = 0;
    const at = this.now();
    this.rateLimitedAtMs = at;
    this.rateLimitUntilMs = at + (retryAfterMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS);
    this.rateLimitSignals += 1;
    return retryAfterMs;
  }

  /** Drop the outstanding rate-limit signal — evidence of progress beats a stale event. */
  private clearRateLimit(): void {
    this.rateLimitedAtMs = null;
    this.rateLimitUntilMs = 0;
    this.rateLimitSignals = 0;
  }
}

function extractRetryAfterMs(msg: NdjsonMessage): number | undefined {
  if (typeof msg.retry_after_ms === "number") return msg.retry_after_ms;
  if (typeof msg.retry_after === "number") return msg.retry_after * 1000;
  return undefined;
}

/**
 * Construct a type-safe AssistantMsg from a fallback parse result (or raw message).
 * Fills in required fields with safe defaults so downstream consumers of
 * `session:response` never hit undefined access on typed fields.
 */
function buildFallbackAssistant(raw: NdjsonMessage, loose?: AssistantFallbackMsg): AssistantMsg {
  const rawObj = raw as Record<string, unknown>;
  const rawMsg = (rawObj.message as Record<string, unknown> | undefined) ?? {};
  const looseMessage = loose?.message;
  return {
    type: "assistant",
    message: {
      id: (rawMsg.id as string) ?? "unknown",
      type: "message",
      role: "assistant",
      model: (rawMsg.model as string) ?? "unknown",
      content: (rawMsg.content as AssistantMsg["message"]["content"]) ?? [],
      stop_reason: (rawMsg.stop_reason as string) ?? null,
      usage: looseMessage?.usage ?? { input_tokens: 0, output_tokens: 0 },
    },
    parent_tool_use_id: (rawObj.parent_tool_use_id as string) ?? null,
    error: rawObj.error as string | undefined,
    uuid: (rawObj.uuid as string) ?? "unknown",
    session_id: (rawObj.session_id as string) ?? "unknown",
  };
}
