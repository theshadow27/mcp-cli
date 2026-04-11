/**
 * Codex session lifecycle manager.
 *
 * Orchestrates CodexProcess + CodexRpcClient to implement the
 * thread/turn lifecycle. Maps Codex protocol events to
 * AgentSessionEvent for the daemon to consume.
 */

import type { AgentPermissionRequest, AgentSessionEvent, AgentSessionInfo, AgentSessionState } from "@mcp-cli/core";
import type { PermissionRule } from "@mcp-cli/permissions";
import {
  type EventMapState,
  createEventMapState,
  isLegacyEvent,
  mapApprovalToPermission,
  mapNotification,
} from "./codex-event-map";
import { buildRules, evaluateApproval } from "./codex-permission-adapter";
import { CodexProcess } from "./codex-process";
import { CodexRpcClient } from "./codex-rpc";
import { type TranscriptEntry, itemToTranscript } from "./codex-transcript";
import type { InitializeResult, Thread, ThreadItem, ThreadStartResult, Turn, TurnStartResult } from "./schemas";

/** Default watchdog timeout: 5 minutes with no events kills the process. */
export const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000;

export interface CodexSessionConfig {
  /** Working directory for the codex process. */
  cwd: string;
  /** Initial prompt text. */
  prompt: string;
  /** Model override (e.g. "codex-mini", "o4-mini"). */
  model?: string;
  /** Sandbox policy. Defaults to "read-only". */
  sandbox?: "read-only" | "danger-full-access";
  /**
   * Approval policy. Defaults to "on-request".
   * - "auto_approve" (alias: "never"): auto-approve ALL tool calls with no human review.
   *    WARNING: every destructive command will be silently approved.
   * - "on-request": prompt for each tool call (default, safest).
   * - "unless-allow-listed": auto-approve allowed tools, prompt for the rest.
   */
  approvalPolicy?: "auto_approve" | "never" | "on-request" | "unless-allow-listed";
  /** Permission rules in Claude format. */
  allowedTools?: readonly string[];
  /** Deny rules in Claude format. */
  disallowedTools?: readonly string[];
  /** Worktree path (for session info). */
  worktree?: string;
  /** Repository root for worktree cleanup. */
  repoRoot?: string;
  /** Override the codex command. */
  command?: string[];
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** Watchdog timeout in ms. Defaults to WATCHDOG_TIMEOUT_MS (5 min). Set 0 to disable. */
  watchdogTimeoutMs?: number;
}

export type SessionEventHandler = (event: AgentSessionEvent) => void;

export class CodexSession {
  readonly sessionId: string;
  private readonly createdAt = Date.now();
  private state: AgentSessionState = "connecting";
  private proc: CodexProcess | null = null;
  private rpc: CodexRpcClient | null = null;
  private eventState: EventMapState;
  private thread: Thread | null = null;
  private currentTurn: Turn | null = null;
  private readonly config: CodexSessionConfig;
  private readonly rules: PermissionRule[];
  private readonly pendingPermissions = new Map<string, AgentPermissionRequest>();
  private readonly transcript: TranscriptEntry[] = [];
  private model: string | null = null;
  private readonly eventHandler: SessionEventHandler;
  private readonly watchdogTimeoutMs: number;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  /** Resolvers for waitForResult/waitForEvent. */
  private resultWaiters: Array<(event: AgentSessionEvent) => void> = [];
  private eventWaiters: Array<(event: AgentSessionEvent) => void> = [];

  constructor(sessionId: string, config: CodexSessionConfig, onEvent: SessionEventHandler) {
    this.sessionId = sessionId;
    this.config = config;
    this.eventHandler = onEvent;
    this.eventState = createEventMapState();
    this.rules = buildRules(config.allowedTools, config.disallowedTools);
    this.watchdogTimeoutMs = config.watchdogTimeoutMs ?? WATCHDOG_TIMEOUT_MS;
  }

  /** Start the session: spawn process, handshake, start thread and first turn. */
  async start(): Promise<void> {
    this.setState("connecting");

    this.proc = new CodexProcess({
      cwd: this.config.cwd,
      env: this.config.env,
      command: this.config.command,
      onMessage: (msg) => this.handleMessage(msg),
      onExit: (code, signal) => this.handleExit(code, signal),
      onError: (err, line) => {
        console.error(`[codex-session:${this.sessionId}] Parse error: ${err.message} (line: ${line})`);
      },
    });

    this.proc.spawn();

    this.rpc = new CodexRpcClient(this.proc, {
      onNotification: (method, params) => this.handleNotification(method, params),
      onServerRequest: (id, method, params) => this.handleServerRequest(id, method, params),
    });

    try {
      // Step 1: Initialize handshake
      const initResult = (await this.rpc.request("initialize", {
        clientInfo: { name: "mcp-cli-codex", version: "0.1.0" },
        capabilities: { experimentalApi: false },
      })) as InitializeResult;

      // Send initialized notification
      await this.rpc.notify("initialized");

      this.model = this.config.model ?? "codex";
      this.setState("init");
      this.emit({
        type: "session:init",
        sessionId: this.sessionId,
        provider: "codex",
        model: this.model,
        cwd: this.config.cwd,
      });

      // Step 2: Start thread
      // Map "auto_approve" alias to the Codex protocol value "never"
      const rawPolicy = this.config.approvalPolicy ?? "on-request";
      const protocolPolicy = rawPolicy === "auto_approve" ? "never" : rawPolicy;
      const threadResult = (await this.rpc.request("thread/start", {
        cwd: this.config.cwd,
        model: this.config.model,
        sandbox: this.config.sandbox ?? "read-only",
        approvalPolicy: protocolPolicy,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      })) as ThreadStartResult;

      this.thread = threadResult.thread;

      // Step 3: Start first turn with the prompt
      await this.startTurn(this.config.prompt);
    } catch (err) {
      // Kill the process on any initialization failure to prevent leaks
      this.proc.kill();
      throw err;
    }
  }

  /** Send a follow-up message (starts a new turn on the existing thread). */
  async send(message: string): Promise<void> {
    if (!this.thread) throw new Error("No active thread");
    if (this.state !== "idle" && this.state !== "result") {
      throw new Error(`Cannot send in state: ${this.state}`);
    }
    await this.startTurn(message);
  }

  /** Interrupt the current turn. */
  async interrupt(): Promise<void> {
    if (!this.rpc || !this.thread || !this.currentTurn) return;
    await this.rpc.request("turn/interrupt", {
      threadId: this.thread.id,
      turnId: this.currentTurn.id,
    });
  }

  /** Approve a pending permission request. */
  approve(requestId: string): void {
    if (!this.rpc) return;
    const perm = this.pendingPermissions.get(requestId);
    if (!perm) return;
    this.pendingPermissions.delete(requestId);
    // The requestId is the approvalId, but the RPC response needs the
    // original server request id — stored in the approval's requestId
    this.rpc.respondToServerRequest(requestId, { decision: "accept" });
    if (this.pendingPermissions.size === 0 && this.state === "waiting_permission") {
      this.setState("active");
    }
  }

  /** Deny a pending permission request. */
  deny(requestId: string): void {
    if (!this.rpc) return;
    const perm = this.pendingPermissions.get(requestId);
    if (!perm) return;
    this.pendingPermissions.delete(requestId);
    this.rpc.respondToServerRequest(requestId, { decision: "decline" });
    if (this.pendingPermissions.size === 0 && this.state === "waiting_permission") {
      this.setState("active");
    }
  }

  /** Terminate the session. */
  terminate(): void {
    this.clearWatchdog();
    this.proc?.kill();
    this.rpc?.rejectAll("Session terminated");
    this.setState("ended");
    this.emit({ type: "session:ended" });
    this.rejectAllWaiters("Session terminated");
  }

  /** Wait for a turn result or error. */
  waitForResult(timeoutMs: number): Promise<AgentSessionEvent> {
    if (this.state === "ended") {
      return Promise.reject(new Error("Session already ended"));
    }
    return new Promise<AgentSessionEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.resultWaiters = this.resultWaiters.filter((w) => w !== waiter);
        reject(new Error(`waitForResult timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      const waiter = (event: AgentSessionEvent) => {
        if (event.type === "session:result" || event.type === "session:error" || event.type === "session:ended") {
          clearTimeout(timer);
          this.resultWaiters = this.resultWaiters.filter((w) => w !== waiter);
          resolve(event);
        }
      };
      this.resultWaiters.push(waiter);
    });
  }

  /** Wait for any actionable event. */
  waitForEvent(timeoutMs: number): Promise<AgentSessionEvent> {
    if (this.state === "ended") {
      return Promise.reject(new Error("Session already ended"));
    }
    return new Promise<AgentSessionEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter((w) => w !== waiter);
        reject(new Error(`waitForEvent timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      const waiter = (event: AgentSessionEvent) => {
        clearTimeout(timer);
        this.eventWaiters = this.eventWaiters.filter((w) => w !== waiter);
        resolve(event);
      };
      this.eventWaiters.push(waiter);
    });
  }

  /** Get current session info. */
  getInfo(): AgentSessionInfo {
    return {
      sessionId: this.sessionId,
      name: null,
      provider: "codex",
      state: this.state,
      model: this.model,
      cwd: this.config.cwd,
      cost: null, // Codex doesn't report cost
      tokens: this.eventState.totalTokens,
      reasoningTokens: this.eventState.reasoningTokens,
      numTurns: this.eventState.numTurns,
      pendingPermissions: this.pendingPermissions.size,
      pendingPermissionDetails: [...this.pendingPermissions.values()],
      worktree: this.config.worktree ?? null,
      repoRoot: this.config.repoRoot ?? null,
      processAlive: this.proc?.alive ?? false,
      rateLimited: false,
      createdAt: this.createdAt,
    };
  }

  /** Get the transcript. */
  getTranscript(): readonly TranscriptEntry[] {
    return this.transcript;
  }

  /** Current session state. */
  get currentState(): AgentSessionState {
    return this.state;
  }

  // ── Internal ──

  private async startTurn(text: string): Promise<void> {
    if (!this.rpc || !this.thread) throw new Error("Session not initialized");
    this.setState("active");
    this.eventState.lastResultText = "";
    this.eventState.currentDiff = null;

    const turnResult = (await this.rpc.request("turn/start", {
      threadId: this.thread.id,
      input: [{ type: "text", text, text_elements: [] }],
    })) as TurnStartResult;

    this.currentTurn = turnResult.turn;
    this.resetWatchdog();
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Route through the RPC client for correlation
    this.rpc?.handleMessage(msg);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    // Skip legacy duplicate events
    if (isLegacyEvent(method)) return;
    this.resetWatchdog();

    // Track item metadata for transcript
    if (method === "item/completed") {
      const item = (params as { item?: ThreadItem }).item;
      if (item) {
        const entries = itemToTranscript(item);
        this.transcript.push(...entries);
      }
    }

    // Map to AgentSessionEvents
    const events = mapNotification(method, params, this.eventState, this.sessionId, "codex");
    for (const event of events) {
      // Update state based on event type
      if (event.type === "session:result") {
        this.clearWatchdog();
        this.setState("idle");
        this.currentTurn = null;
      } else if (event.type === "session:error") {
        this.clearWatchdog();
        this.setState("idle");
        this.currentTurn = null;
      }
      this.emit(event);
    }
  }

  private handleServerRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    this.resetWatchdog();
    // Map approval requests to permission requests
    const permission = mapApprovalToPermission(method, params, this.eventState);
    if (!permission) {
      // Unknown server request — auto-decline
      this.rpc?.respondToServerRequest(id, { decision: "decline" });
      return;
    }

    // If approval policy is "auto_approve" (or legacy "never"), auto-approve everything
    if (this.config.approvalPolicy === "auto_approve" || this.config.approvalPolicy === "never") {
      this.rpc?.respondToServerRequest(id, { decision: "accept" });
      return;
    }

    // Evaluate against permission rules
    const decision = evaluateApproval(permission, this.rules);

    if (decision.resolved) {
      if (decision.allow) {
        this.rpc?.respondToServerRequest(id, { decision: "accept" });
      } else {
        this.rpc?.respondToServerRequest(id, { decision: "decline" });
      }
      return;
    }

    // Unresolved — needs manual review. Store as pending and emit event.
    // Use the JSON-RPC id as the requestId so approve/deny can respond correctly.
    const permWithId: AgentPermissionRequest = {
      ...permission,
      requestId: String(id),
    };
    this.pendingPermissions.set(String(id), permWithId);
    this.setState("waiting_permission");
    this.emit({ type: "session:permission_request", request: permWithId });
  }

  private handleExit(code: number | null, _signal: string | null): void {
    this.clearWatchdog();
    this.rpc?.rejectAll("Process exited");

    if (this.state !== "ended") {
      this.setState("ended");
      if (code !== 0 && code !== null) {
        this.emit({ type: "session:error", errors: [`Codex process exited with code ${code}`], cost: null });
      }
      this.emit({ type: "session:ended" });
    }
    this.rejectAllWaiters("Process exited");
  }

  /** Reject all pending result/event waiters (e.g. on exit or terminate). */
  private rejectAllWaiters(reason: string): void {
    // Note: emit() already dispatches session:ended to waiters that filter for it.
    // This handles any waiters that didn't resolve from the emitted events
    // (e.g. waitForEvent waiters that were added after the last emit).
    // Clear arrays to avoid double-resolution — spread first so filter inside waiter is safe.
    const rw = this.resultWaiters;
    const ew = this.eventWaiters;
    this.resultWaiters = [];
    this.eventWaiters = [];
    const endedEvent: AgentSessionEvent = { type: "session:ended" };
    for (const w of rw) w(endedEvent);
    for (const w of ew) w(endedEvent);
  }

  private resetWatchdog(): void {
    if (this.watchdogTimeoutMs <= 0) return;
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      this.proc?.kill();
      this.rpc?.rejectAll("Watchdog timeout");
      if (this.state !== "ended") {
        this.setState("ended");
        this.emit({
          type: "session:error",
          errors: [`Codex process watchdog timeout — no events for ${Math.round(this.watchdogTimeoutMs / 1000)}s`],
          cost: null,
        });
        this.emit({ type: "session:ended" });
      }
      this.rejectAllWaiters("Watchdog timeout");
    }, this.watchdogTimeoutMs);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private setState(newState: AgentSessionState): void {
    this.state = newState;
  }

  private emit(event: AgentSessionEvent): void {
    this.eventHandler(event);

    // Notify waiters
    for (const waiter of [...this.resultWaiters]) {
      waiter(event);
    }
    for (const waiter of [...this.eventWaiters]) {
      waiter(event);
    }
  }
}
