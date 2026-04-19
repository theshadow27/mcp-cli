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
  interruptRequest,
  permissionAllow,
  permissionDeny,
  userMessage,
} from "./ndjson";

// ── Events emitted by handleMessage ──

export type SessionEvent =
  | { type: "session:init"; sessionId: string; model: string; cwd: string; state: SessionStateEnum }
  | { type: "session:response"; message: AssistantMsg }
  | { type: "session:permission_request"; requestId: string; request: CanUseToolMsg["request"] }
  | { type: "session:result"; cost: number; tokens: number; numTurns: number; result: string }
  | { type: "session:error"; errors: string[]; cost: number }
  | { type: "session:rate_limited"; sessionId: string }
  | { type: "session:disconnected"; reason: string }
  | { type: "session:ended" }
  | { type: "session:cleared" }
  | { type: "session:model_changed"; model: string }
  | { type: "session:containment_warning"; toolName: string; reason: string; strikes: number }
  | { type: "session:containment_denied"; toolName: string; reason: string; strikes: number }
  | { type: "session:containment_escalated"; toolName: string; reason: string; strikes: number };

// ── Outbound message (string ready to send over WS) ──

export type OutboundMessage = string;

// ── Request ID generation ──

export type RequestIdGenerator = () => string;

function createDefaultIdGenerator(): RequestIdGenerator {
  let nextId = 1;
  return () => `mcpd-${nextId++}`;
}

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
  rateLimited = false;
  readonly pendingPermissions = new Map<string, CanUseToolMsg["request"]>();
  private readonly genRequestId: RequestIdGenerator;

  /**
   * Set to true when the last handleMessage used a fallback schema instead
   * of the strict one. Cleared on every handleMessage call. Allows callers
   * (ws-server) to log diagnostics without the state machine needing a logger.
   */
  parseMismatch = false;

  constructor(sessionId: string, genRequestId?: RequestIdGenerator) {
    this.sessionId = sessionId;
    this.state = "connecting";
    this.genRequestId = genRequestId ?? createDefaultIdGenerator();
  }

  /**
   * Process an inbound NDJSON message from the CLI.
   * Returns zero or more events for observers.
   */
  handleMessage(msg: NdjsonMessage): SessionEvent[] {
    this.parseMismatch = false;
    if (IGNORED_TYPES.has(msg.type)) return [];
    if (msg.type === "system" && msg.subtype === "status") return [];

    if (msg.type === "system" && msg.subtype === "init") return this.handleInit(msg);
    if (msg.type === "assistant") return this.handleAssistant(msg);
    if (msg.type === "result") return this.handleResult(msg);
    if (msg.type === "control_request") return this.handleControlRequest(msg);

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
    return permissionDeny(requestId, message ?? "Denied by session controller");
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
  }

  /** Reset state for a /clear (kill+respawn). Preserves cumulative cost/tokens. */
  resetForClear(): SessionEvent[] {
    if (this.state === "ended") return [];
    this.state = "connecting";
    this.pendingPermissions.clear();
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
      const events: SessionEvent[] = [{ type: "session:response", message: strict.data }];
      if (strict.data.error === "rate_limit") {
        this.rateLimited = true;
        events.push({ type: "session:rate_limited", sessionId: this.sessionId });
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
      const assistant = buildFallbackAssistant(msg, loose.data);
      const events: SessionEvent[] = [{ type: "session:response", message: assistant }];
      if (assistant.error === "rate_limit") {
        this.rateLimited = true;
        events.push({ type: "session:rate_limited", sessionId: this.sessionId });
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
    const successResult = ResultSuccess.safeParse(msg);
    if (successResult.success) {
      const r = successResult.data;
      this.cost = r.total_cost_usd;
      this.numTurns = r.num_turns;
      // Don't add result usage to tokens — assistant messages already accumulate
      // per-message usage throughout the turn. Result usage would double-count.
      this.state = "idle";
      this.rateLimited = false;
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
      return [{ type: "session:error", errors: r.errors, cost: this.cost }];
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

      const errors = r.errors;
      if (r.subtype !== "success" && Array.isArray(errors) && errors.length > 0) {
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
