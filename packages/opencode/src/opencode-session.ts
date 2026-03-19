/**
 * OpenCode session lifecycle manager.
 *
 * Orchestrates OpenCodeProcess + OpenCodeClient + OpenCodeSse to implement
 * the session lifecycle. Maps OpenCode protocol events to AgentSessionEvent
 * for the daemon to consume.
 *
 * OpenCode lifecycle: spawn serve → discover URL → create session → send prompt
 *   (SSE events stream in)
 *   (permission.asked events need approval)
 *   abort to interrupt
 *
 * Mirrors acp-session.ts but for the OpenCode HTTP+SSE protocol.
 */

import type { AgentPermissionRequest, AgentSessionEvent, AgentSessionInfo, AgentSessionState } from "@mcp-cli/core";
import type { PermissionRule } from "@mcp-cli/permissions";
import { OpenCodeClient } from "./opencode-client";
import {
  type OpenCodeEventMapState,
  buildTurnResult,
  createOpenCodeEventMapState,
  mapSseEvent,
} from "./opencode-event-map";
import { buildRules, evaluatePermission, mapPermissionRequest } from "./opencode-permission-adapter";
import { OpenCodeProcess } from "./opencode-process";
import { OpenCodeSse, type OpenCodeSseEvent } from "./opencode-sse";
import {
  type TranscriptEntry,
  type TranscriptState,
  assistantEntry,
  createTranscriptState,
  processEvent,
  userEntry,
} from "./opencode-transcript";

/** Default watchdog timeout: 5 minutes with no events kills the process. */
export const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000;

export interface OpenCodeSessionConfig {
  /** Working directory for the agent process. */
  cwd: string;
  /** Initial prompt text. */
  prompt: string;
  /** LLM provider override (e.g. "anthropic", "openai", "google"). */
  provider?: string;
  /** Model override (informational). */
  model?: string;
  /** Permission rules in Claude format. */
  allowedTools?: readonly string[];
  /** Deny rules in Claude format. */
  disallowedTools?: readonly string[];
  /** Worktree path (for session info). */
  worktree?: string;
  /** Repository root for worktree cleanup. */
  repoRoot?: string;
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** Watchdog timeout in ms. Defaults to WATCHDOG_TIMEOUT_MS (5 min). Set 0 to disable. */
  watchdogTimeoutMs?: number;
}

export type SessionEventHandler = (event: AgentSessionEvent) => void;

export class OpenCodeSession {
  readonly sessionId: string;
  private state: AgentSessionState = "connecting";
  private proc: OpenCodeProcess | null = null;
  private client: OpenCodeClient | null = null;
  private sse: OpenCodeSse | null = null;
  private eventState: OpenCodeEventMapState;
  private transcriptState: TranscriptState;
  private openCodeSessionId: string | null = null;
  private readonly config: OpenCodeSessionConfig;
  private readonly rules: PermissionRule[];
  private readonly pendingPermissions = new Map<string, AgentPermissionRequest>();
  private readonly transcript: TranscriptEntry[] = [];
  private model: string | null = null;
  private diff: string | null = null;
  private readonly eventHandler: SessionEventHandler;
  private readonly watchdogTimeoutMs: number;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  /** Resolvers for waitForResult/waitForEvent. */
  private resultWaiters: Array<(event: AgentSessionEvent) => void> = [];
  private eventWaiters: Array<(event: AgentSessionEvent) => void> = [];

  constructor(sessionId: string, config: OpenCodeSessionConfig, onEvent: SessionEventHandler) {
    this.sessionId = sessionId;
    this.config = config;
    this.eventHandler = onEvent;
    this.eventState = createOpenCodeEventMapState();
    this.transcriptState = createTranscriptState();
    this.rules = buildRules(config.allowedTools, config.disallowedTools);
    this.watchdogTimeoutMs = config.watchdogTimeoutMs ?? WATCHDOG_TIMEOUT_MS;
  }

  /** Start the session: spawn process, discover URL, connect SSE, create session, send first prompt. */
  async start(): Promise<void> {
    this.setState("connecting");

    this.proc = new OpenCodeProcess({
      cwd: this.config.cwd,
      env: this.config.env,
      onExit: (code, signal) => this.handleExit(code, signal),
    });

    let baseUrl: string;
    try {
      baseUrl = await this.proc.spawn();
    } catch (err) {
      this.proc.kill();
      throw err;
    }

    this.client = new OpenCodeClient(baseUrl);

    // Connect SSE for event streaming
    this.sse = new OpenCodeSse({
      baseUrl,
      cwd: this.config.cwd,
      onEvent: (event) => this.handleSseEvent(event),
      onClose: () => {
        if (this.state !== "ended") {
          this.setState("disconnected");
          this.emit({ type: "session:disconnected", reason: "SSE connection closed" });
        }
      },
      onError: (err) => {
        console.error(`[opencode-session:${this.sessionId}] SSE error: ${err.message}`);
      },
    });

    // Start SSE in the background (don't await — it's a long-lived connection)
    this.sse.connect();

    this.model = this.config.model ?? this.config.provider ?? "opencode";
    this.setState("init");
    this.emit({
      type: "session:init",
      sessionId: this.sessionId,
      provider: "opencode",
      model: this.model,
      cwd: this.config.cwd,
    });

    try {
      // Create session
      const session = await this.client.createSession({ cwd: this.config.cwd });
      this.openCodeSessionId = session.id;

      // Send first prompt
      this.transcript.push(userEntry(this.config.prompt));
      await this.startPrompt(this.config.prompt);
    } catch (err) {
      this.proc.kill();
      throw err;
    }
  }

  /** Send a follow-up message. */
  async send(message: string): Promise<void> {
    if (!this.openCodeSessionId) throw new Error("No active session");
    if (this.state !== "idle" && this.state !== "result") {
      throw new Error(`Cannot send in state: ${this.state}`);
    }
    this.transcript.push(userEntry(message));
    await this.startPrompt(message);
  }

  /** Interrupt the current prompt. */
  async interrupt(): Promise<void> {
    if (!this.client || !this.openCodeSessionId) return;
    await this.client.abortSession(this.openCodeSessionId);
  }

  /** Approve a pending permission request. */
  approve(requestId: string): void {
    if (!this.client) return;
    const perm = this.pendingPermissions.get(requestId);
    if (!perm) return;
    this.pendingPermissions.delete(requestId);

    this.client.replyPermission(requestId, "always").catch((err: unknown) => {
      console.error(`[opencode-session:${this.sessionId}] Permission reply error: ${err}`);
    });

    if (this.pendingPermissions.size === 0 && this.state === "waiting_permission") {
      this.setState("active");
    }
  }

  /** Deny a pending permission request. */
  deny(requestId: string): void {
    if (!this.client) return;
    const perm = this.pendingPermissions.get(requestId);
    if (!perm) return;
    this.pendingPermissions.delete(requestId);

    this.client.replyPermission(requestId, "reject").catch((err: unknown) => {
      console.error(`[opencode-session:${this.sessionId}] Permission deny error: ${err}`);
    });

    if (this.pendingPermissions.size === 0 && this.state === "waiting_permission") {
      this.setState("active");
    }
  }

  /** Terminate the session. */
  terminate(): void {
    if (this.state === "ended") return;
    this.clearWatchdog();
    this.sse?.disconnect();
    this.proc?.kill();
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

      if (this.state === "ended") {
        clearTimeout(timer);
        this.resultWaiters = this.resultWaiters.filter((w) => w !== waiter);
        resolve({ type: "session:ended" });
      }
    });
  }

  /** Wait for any actionable event. Returns a cancellable promise. */
  waitForEvent(timeoutMs: number): Promise<AgentSessionEvent> & { cancel?: () => void } {
    if (this.state === "ended") {
      return Promise.reject(new Error("Session already ended"));
    }

    let cancelFn: (() => void) | undefined;

    const promise = new Promise<AgentSessionEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter((w) => w !== waiter);
        reject(new Error(`waitForEvent timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      const waiter = (event: AgentSessionEvent) => {
        clearTimeout(timer);
        this.eventWaiters = this.eventWaiters.filter((w) => w !== waiter);
        resolve(event);
      };

      cancelFn = () => {
        clearTimeout(timer);
        this.eventWaiters = this.eventWaiters.filter((w) => w !== waiter);
        reject(new Error("waitForEvent cancelled"));
      };

      this.eventWaiters.push(waiter);

      if (this.state === "ended") {
        clearTimeout(timer);
        this.eventWaiters = this.eventWaiters.filter((w) => w !== waiter);
        resolve({ type: "session:ended" });
      }
    }) as Promise<AgentSessionEvent> & { cancel?: () => void };

    promise.cancel = cancelFn;
    return promise;
  }

  /** Get current session info. */
  getInfo(): AgentSessionInfo {
    return {
      sessionId: this.sessionId,
      provider: "opencode",
      state: this.state,
      model: this.model,
      cwd: this.config.cwd,
      cost: this.eventState.cost,
      tokens: this.eventState.totalTokens,
      reasoningTokens: this.eventState.reasoningTokens,
      numTurns: this.eventState.numTurns,
      pendingPermissions: this.pendingPermissions.size,
      pendingPermissionDetails: [...this.pendingPermissions.values()],
      worktree: this.config.worktree ?? null,
      repoRoot: this.config.repoRoot ?? null,
      processAlive: this.proc?.alive ?? false,
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

  private async startPrompt(text: string): Promise<void> {
    if (!this.client || !this.openCodeSessionId) throw new Error("Session not initialized");
    this.setState("active");
    this.eventState.currentResponseText = "";

    // Send prompt asynchronously — results arrive via SSE
    this.client.sendPromptAsync(this.openCodeSessionId, text).catch((err) => {
      if (this.state === "ended") return;
      this.clearWatchdog();
      this.setState("idle");
      this.emit({
        type: "session:error",
        errors: [err instanceof Error ? err.message : String(err)],
        cost: this.eventState.cost,
      });
    });

    this.resetWatchdog();
  }

  private handleSseEvent(event: OpenCodeSseEvent): void {
    this.resetWatchdog();

    // Handle permission events specially
    if (event.type === "permission.asked") {
      this.handlePermissionAsked(event);
      return;
    }

    if (event.type === "permission.replied") {
      const requestId = event.data.id as string;
      this.pendingPermissions.delete(requestId);
      if (this.pendingPermissions.size === 0 && this.state === "waiting_permission") {
        this.setState("active");
      }
      return;
    }

    // Handle session status for idle detection (turn completion)
    if (event.type === "session.status") {
      const status = event.data.status as string | undefined;
      if (status === "idle" && this.state === "active") {
        this.handleTurnComplete();
        return;
      }
    }

    // Store diffs
    if (event.type === "session.diff") {
      this.diff = (event.data.diff as string) ?? null;
    }

    // Map to AgentSessionEvents
    const events = mapSseEvent(event, this.eventState);
    for (const e of events) {
      this.emit(e);
    }

    // Process for transcript
    const entries = processEvent(event, this.transcriptState);
    this.transcript.push(...entries);
  }

  private handleTurnComplete(): void {
    this.clearWatchdog();

    const agentResult = buildTurnResult(this.eventState);

    if (agentResult.result) {
      this.transcript.push(assistantEntry(agentResult.result));
    }

    if (this.diff) {
      agentResult.diff = this.diff;
      this.diff = null;
    }

    this.setState("idle");
    this.emit({ type: "session:result", result: agentResult });
  }

  private handlePermissionAsked(event: OpenCodeSseEvent): void {
    const permission = mapPermissionRequest(event.data);
    const requestId = event.data.id as string;

    // Evaluate against permission rules
    const decision = evaluatePermission(permission, this.rules);

    if (decision.resolved) {
      // Auto-resolve based on rules
      this.client?.replyPermission(requestId, decision.reply).catch((err: unknown) => {
        console.error(`[opencode-session:${this.sessionId}] Auto-permission reply error: ${err}`);
      });
      return;
    }

    // Unresolved — needs manual review
    const permWithId: AgentPermissionRequest = {
      ...permission,
      requestId,
    };
    this.pendingPermissions.set(requestId, permWithId);
    this.setState("waiting_permission");
    this.emit({ type: "session:permission_request", request: permWithId });
  }

  private handleExit(code: number | null, _signal: string | null): void {
    this.clearWatchdog();
    this.sse?.disconnect();

    if (this.state !== "ended") {
      this.setState("ended");
      if (code !== 0 && code !== null) {
        this.emit({
          type: "session:error",
          errors: [`OpenCode process exited with code ${code}`],
          cost: this.eventState.cost,
        });
      }
      this.emit({ type: "session:ended" });
    }
    this.rejectAllWaiters("Process exited");
  }

  private rejectAllWaiters(reason: string): void {
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
      this.sse?.disconnect();
      this.proc?.kill();
      if (this.state !== "ended") {
        this.setState("ended");
        this.emit({
          type: "session:error",
          errors: [`OpenCode watchdog timeout — no events for ${Math.round(this.watchdogTimeoutMs / 1000)}s`],
          cost: this.eventState.cost,
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

    for (const waiter of [...this.resultWaiters]) {
      waiter(event);
    }
    for (const waiter of [...this.eventWaiters]) {
      waiter(event);
    }
  }
}
