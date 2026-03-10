/**
 * Session state machine for Claude Code WebSocket SDK sessions.
 *
 * Processes inbound NDJSON messages from the CLI, tracks session metadata
 * (model, cwd, cost, tokens, pending permissions), and produces typed events
 * for the WS server / virtual-server layer to observe.
 */

import type { SessionStateEnum } from "@mcp-cli/core";
import type { Assistant as AssistantMsg, CanUseTool as CanUseToolMsg, NdjsonMessage } from "./ndjson";
import {
  Assistant as AssistantSchema,
  CanUseTool as CanUseToolSchema,
  ResultError,
  ResultSuccess,
  SystemInit,
  interruptRequest,
  permissionAllow,
  permissionDeny,
  userMessage,
} from "./ndjson";

// ── Events emitted by handleMessage ──

export type SessionEvent =
  | { type: "session:init"; sessionId: string; model: string; cwd: string }
  | { type: "session:response"; message: AssistantMsg }
  | { type: "session:permission_request"; requestId: string; request: CanUseToolMsg["request"] }
  | { type: "session:result"; cost: number; tokens: number; numTurns: number; result: string }
  | { type: "session:error"; errors: string[]; cost: number }
  | { type: "session:disconnected"; reason: string }
  | { type: "session:ended" }
  | { type: "session:cleared" }
  | { type: "session:model_changed"; model: string };

// ── Outbound message (string ready to send over WS) ──

export type OutboundMessage = string;

// ── Request ID generation ──

export type RequestIdGenerator = () => string;

function createDefaultIdGenerator(): RequestIdGenerator {
  let nextId = 1;
  return () => `mcpd-${nextId++}`;
}

// ── Ignored message types ──

const IGNORED_TYPES: ReadonlySet<string> = new Set([
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
  private readonly genRequestId: RequestIdGenerator;

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
    const parsed = SystemInit.parse(msg);
    this.model = parsed.model;
    this.cwd = parsed.cwd;
    this.state = "init";

    return [
      {
        type: "session:init",
        sessionId: parsed.session_id,
        model: parsed.model,
        cwd: parsed.cwd,
      },
    ];
  }

  private handleAssistant(msg: NdjsonMessage): SessionEvent[] {
    const parsed = AssistantSchema.parse(msg);
    this.state = "active";

    // Accumulate tokens from each assistant message
    const usage = parsed.message.usage;
    this.tokens += usage.input_tokens + usage.output_tokens;

    return [{ type: "session:response", message: parsed }];
  }

  private handleResult(msg: NdjsonMessage): SessionEvent[] {
    const successResult = ResultSuccess.safeParse(msg);
    if (successResult.success) {
      const r = successResult.data;
      const resultTokens = r.usage.input_tokens + r.usage.output_tokens;
      this.cost += r.total_cost_usd;
      this.numTurns += r.num_turns;
      this.tokens += resultTokens;
      this.state = "idle";
      return [
        {
          type: "session:result",
          cost: r.total_cost_usd,
          tokens: resultTokens,
          numTurns: r.num_turns,
          result: r.result,
        },
      ];
    }

    const errorResult = ResultError.safeParse(msg);
    if (errorResult.success) {
      const r = errorResult.data;
      this.cost += r.total_cost_usd;
      this.numTurns += r.num_turns;
      this.state = "idle";
      return [{ type: "session:error", errors: r.errors, cost: r.total_cost_usd }];
    }

    return [];
  }

  private handleControlRequest(msg: NdjsonMessage): SessionEvent[] {
    // Only handle can_use_tool control requests
    const parsed = CanUseToolSchema.safeParse(msg);
    if (!parsed.success) return [];

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
