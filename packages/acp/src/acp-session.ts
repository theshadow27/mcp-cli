/**
 * ACP session lifecycle manager.
 *
 * Orchestrates AcpProcess + AcpRpcClient to implement the ACP
 * session lifecycle. Maps ACP protocol events to AgentSessionEvent
 * for the daemon to consume.
 *
 * ACP lifecycle: initialize → session/new → session/prompt
 *   (streaming session/update notifications)
 *   (server-initiated session/request_permission, fs/*, terminal/* requests)
 *   session/cancel to interrupt
 *
 * Mirrors codex-session.ts but for the ACP protocol.
 */

import { resolve } from "node:path";
import type { AgentPermissionRequest, AgentSessionEvent, AgentSessionInfo, AgentSessionState } from "@mcp-cli/core";
import type { PermissionRule } from "@mcp-cli/permissions";
import { type AcpEventMapState, buildTurnResult, createAcpEventMapState, mapSessionUpdate } from "./acp-event-map";
import { buildRules, evaluatePermission, findOptionId, mapPermissionRequest } from "./acp-permission-adapter";
import { AcpProcess } from "./acp-process";
import { AcpRpcClient } from "./acp-rpc";
import {
  type TranscriptEntry,
  type TranscriptState,
  assistantEntry,
  createTranscriptState,
  processUpdate,
  userEntry,
} from "./acp-transcript";
import { resolveAgentCommand } from "./agents";
import type { InitializeResult, PermissionRequestParams, SessionNewResult, SessionPromptResult } from "./schemas";

/** Default watchdog timeout: 5 minutes with no events kills the process. */
export const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000;

export interface AcpSessionConfig {
  /** Working directory for the agent process. */
  cwd: string;
  /** Initial prompt text. */
  prompt: string;
  /** Agent name (e.g. "copilot", "gemini") or custom command. */
  agent: string;
  /** Custom command override (takes precedence over agent name). */
  customCommand?: string[];
  /** Model override (informational — passed to session/new if supported). */
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

export class AcpSession {
  readonly sessionId: string;
  private state: AgentSessionState = "connecting";
  private proc: AcpProcess | null = null;
  private rpc: AcpRpcClient | null = null;
  private eventState: AcpEventMapState;
  private transcriptState: TranscriptState;
  private acpSessionId: string | null = null;
  private readonly config: AcpSessionConfig;
  private readonly rules: PermissionRule[];
  private readonly pendingPermissions = new Map<string, AgentPermissionRequest>();
  private readonly transcript: TranscriptEntry[] = [];
  private model: string | null = null;
  private agentDisplayName: string;
  private readonly eventHandler: SessionEventHandler;
  private readonly watchdogTimeoutMs: number;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  /** Resolvers for waitForResult/waitForEvent. */
  private resultWaiters: Array<(event: AgentSessionEvent) => void> = [];
  private eventWaiters: Array<(event: AgentSessionEvent) => void> = [];

  /** Terminal results storage for server-initiated terminal requests. */
  private readonly terminalResults = new Map<string, { stdout: string; stderr: string; exitCode: number }>();

  constructor(sessionId: string, config: AcpSessionConfig, onEvent: SessionEventHandler) {
    this.sessionId = sessionId;
    this.config = config;
    this.eventHandler = onEvent;
    this.eventState = createAcpEventMapState();
    this.transcriptState = createTranscriptState();
    this.rules = buildRules(config.allowedTools, config.disallowedTools);
    this.watchdogTimeoutMs = config.watchdogTimeoutMs ?? WATCHDOG_TIMEOUT_MS;
    this.agentDisplayName = config.agent;
  }

  /** Start the session: spawn process, handshake, create session, send first prompt. */
  async start(): Promise<void> {
    this.setState("connecting");

    const { command, displayName } = resolveAgentCommand(this.config.agent, this.config.customCommand);
    this.agentDisplayName = displayName;

    this.proc = new AcpProcess({
      cwd: this.config.cwd,
      command,
      env: this.config.env,
      onMessage: (msg) => this.handleMessage(msg),
      onExit: (code, signal) => this.handleExit(code, signal),
      onError: (err, line) => {
        console.error(`[acp-session:${this.sessionId}] Parse error: ${err.message} (line: ${line})`);
      },
    });

    this.proc.spawn();

    this.rpc = new AcpRpcClient(this.proc, {
      onNotification: (method, params) => this.handleNotification(method, params),
      onServerRequest: (id, method, params) => this.handleServerRequest(id, method, params),
    });

    try {
      // Step 1: Initialize handshake
      const initResult = (await this.rpc.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "mcp-cli-acp", version: "0.1.0" },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      })) as InitializeResult;

      this.model = this.config.model ?? this.config.agent;
      this.setState("init");
      this.emit({
        type: "session:init",
        sessionId: this.sessionId,
        provider: "acp",
        model: this.model,
        cwd: this.config.cwd,
      });

      // Step 2: Create session
      const sessionResult = (await this.rpc.request("session/new", {
        cwd: this.config.cwd,
        mcpServers: [],
      })) as SessionNewResult;

      this.acpSessionId = sessionResult.sessionId;

      // Step 3: Send first prompt
      this.transcript.push(userEntry(this.config.prompt));
      await this.startPrompt(this.config.prompt);
    } catch (err) {
      this.proc.kill();
      throw err;
    }
  }

  /** Send a follow-up message. */
  async send(message: string): Promise<void> {
    if (!this.acpSessionId) throw new Error("No active session");
    if (this.state !== "idle" && this.state !== "result") {
      throw new Error(`Cannot send in state: ${this.state}`);
    }
    this.transcript.push(userEntry(message));
    await this.startPrompt(message);
  }

  /** Interrupt the current prompt. */
  async interrupt(): Promise<void> {
    if (!this.rpc || !this.acpSessionId) return;
    await this.rpc.notify("session/cancel", { sessionId: this.acpSessionId });
  }

  /** Approve a pending permission request. */
  approve(requestId: string): void {
    if (!this.rpc) return;
    const perm = this.pendingPermissions.get(requestId);
    if (!perm) return;
    this.pendingPermissions.delete(requestId);

    // Find allow_always option, fall back to allow_once
    const options = this.permissionOptions.get(requestId) ?? [];
    const optionId =
      findOptionId(options, "allow_always") ?? findOptionId(options, "allow_once") ?? options[0]?.optionId;

    if (optionId) {
      this.rpc.respondToServerRequest(requestId, {
        outcome: { outcome: "selected", optionId },
      });
    }
    this.permissionOptions.delete(requestId);

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

    const options = this.permissionOptions.get(requestId) ?? [];
    const optionId =
      findOptionId(options, "reject_once") ?? findOptionId(options, "reject_always") ?? options[0]?.optionId;

    if (optionId) {
      this.rpc.respondToServerRequest(requestId, {
        outcome: { outcome: "selected", optionId },
      });
    }
    this.permissionOptions.delete(requestId);

    if (this.pendingPermissions.size === 0 && this.state === "waiting_permission") {
      this.setState("active");
    }
  }

  /** Terminate the session. */
  terminate(): void {
    if (this.state === "ended") return;
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

      // Re-check: session may have ended between the guard and registration
      if (this.state === "ended") {
        clearTimeout(timer);
        this.resultWaiters = this.resultWaiters.filter((w) => w !== waiter);
        resolve({ type: "session:ended" });
      }
    });
  }

  /** Wait for any actionable event. Returns a cancellable promise (has .cancel()). */
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

      // Re-check: session may have ended between the guard and registration
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
      provider: "acp",
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

  /** Stored permission options for approve/deny to pick the right optionId. */
  private readonly permissionOptions = new Map<string, ReadonlyArray<{ optionId: string; kind: string }>>();

  private async startPrompt(text: string): Promise<void> {
    if (!this.rpc || !this.acpSessionId) throw new Error("Session not initialized");
    this.setState("active");
    this.eventState.currentResponseText = "";

    // ACP uses session/prompt — response arrives when the turn is complete.
    // Meanwhile, session/update notifications stream in.
    this.rpc
      .request("session/prompt", {
        sessionId: this.acpSessionId,
        prompt: [{ type: "text", text }],
      })
      .then((result) => {
        this.handlePromptResponse(result as SessionPromptResult | null);
      })
      .catch((err) => {
        if (this.state === "ended") return; // Already cleaned up
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

  private handlePromptResponse(result: SessionPromptResult | null): void {
    if (this.state === "ended") return;
    this.clearWatchdog();

    // Build result from accumulated state
    const agentResult = buildTurnResult(this.eventState);

    // Add completed assistant message to transcript
    if (agentResult.result) {
      this.transcript.push(assistantEntry(agentResult.result));
    }

    this.setState("idle");
    this.emit({ type: "session:result", result: agentResult });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    this.rpc?.handleMessage(msg);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    this.resetWatchdog();

    if (method === "session/update") {
      // Map to AgentSessionEvents
      const events = mapSessionUpdate(params, this.eventState);
      for (const event of events) {
        this.emit(event);
      }

      // Process for transcript
      const update = (params as { update?: Record<string, unknown> }).update;
      if (update) {
        const entries = processUpdate(update, this.transcriptState);
        this.transcript.push(...entries);
      }
    }
  }

  private handleServerRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    this.resetWatchdog();

    switch (method) {
      case "session/request_permission":
        this.handlePermissionRequest(id, params as unknown as PermissionRequestParams);
        break;
      case "fs/write_text_file":
        this.handleFsWrite(id, params);
        break;
      case "fs/read_text_file":
        this.handleFsRead(id, params);
        break;
      case "terminal/create":
        this.handleTerminalCreate(id, params);
        break;
      case "terminal/output":
        this.handleTerminalOutput(id, params);
        break;
      case "terminal/wait_for_exit":
        this.handleTerminalWaitForExit(id, params);
        break;
      case "terminal/release":
        this.handleTerminalRelease(id, params);
        break;
      case "terminal/kill":
        this.rpc?.respondToServerRequest(id, {});
        break;
      default:
        // Unknown server request — respond with empty result to not block
        this.rpc?.respondToServerRequest(id, {});
        break;
    }
  }

  private handlePermissionRequest(id: number | string, params: PermissionRequestParams): void {
    const permission = mapPermissionRequest(params);

    // Evaluate against permission rules
    const decision = evaluatePermission(permission, this.rules);

    if (decision.resolved) {
      if (decision.allow) {
        const optionId =
          (decision.persistent
            ? findOptionId(params.options, "allow_always")
            : findOptionId(params.options, "allow_once")) ??
          findOptionId(params.options, "allow_once") ??
          params.options[0]?.optionId;

        if (optionId) {
          this.rpc?.respondToServerRequest(id, {
            outcome: { outcome: "selected", optionId },
          });
        }
      } else {
        const optionId = findOptionId(params.options, "reject_once") ?? params.options[0]?.optionId;
        if (optionId) {
          this.rpc?.respondToServerRequest(id, {
            outcome: { outcome: "selected", optionId },
          });
        }
      }
      return;
    }

    // Unresolved — needs manual review
    const permWithId: AgentPermissionRequest = {
      ...permission,
      requestId: String(id),
    };
    this.pendingPermissions.set(String(id), permWithId);
    this.permissionOptions.set(String(id), params.options);
    this.setState("waiting_permission");
    this.emit({ type: "session:permission_request", request: permWithId });
  }

  private async handleFsWrite(id: number | string, params: Record<string, unknown>): Promise<void> {
    const path = params.path as string;
    const content = params.content as string;

    // Validate path is under session cwd
    const resolved = resolve(this.config.cwd, path);
    if (!resolved.startsWith(`${this.config.cwd}/`) && resolved !== this.config.cwd) {
      this.rpc?.respondWithError(id, -1, `Path traversal denied: ${path} is outside session cwd`);
      return;
    }

    try {
      await Bun.write(resolved, content);
      this.rpc?.respondToServerRequest(id, {});
    } catch (err) {
      this.rpc?.respondWithError(id, -1, String(err));
    }
  }

  private async handleFsRead(id: number | string, params: Record<string, unknown>): Promise<void> {
    const path = params.path as string;

    // Validate path is under session cwd
    const resolved = resolve(this.config.cwd, path);
    if (!resolved.startsWith(`${this.config.cwd}/`) && resolved !== this.config.cwd) {
      this.rpc?.respondWithError(id, -1, `Path traversal denied: ${path} is outside session cwd`);
      return;
    }

    try {
      const file = Bun.file(resolved);
      const content = await file.text();
      this.rpc?.respondToServerRequest(id, { content });
    } catch (err) {
      this.rpc?.respondWithError(id, -1, String(err));
    }
  }

  /** Default timeout for terminal commands: 5 minutes. */
  private static readonly TERMINAL_TIMEOUT_MS = 5 * 60 * 1000;

  private async handleTerminalCreate(id: number | string, params: Record<string, unknown>): Promise<void> {
    const cmd = params.command as string;
    const cmdArgs = (params.args as string[]) ?? [];
    const cmdCwd = (params.cwd as string) ?? this.config.cwd;
    try {
      const proc = Bun.spawn([cmd, ...cmdArgs], {
        cwd: cmdCwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
      }, AcpSession.TERMINAL_TIMEOUT_MS);

      const [exitCode, stdoutBuf, stderrBuf] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      clearTimeout(timeout);

      const termId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.terminalResults.set(termId, {
        stdout: stdoutBuf,
        stderr: stderrBuf,
        exitCode,
      });
      this.rpc?.respondToServerRequest(id, { terminalId: termId });
    } catch (err) {
      this.rpc?.respondWithError(id, -1, String(err));
    }
  }

  private handleTerminalOutput(id: number | string, params: Record<string, unknown>): void {
    const termId = params.terminalId as string;
    const result = this.terminalResults.get(termId);
    this.rpc?.respondToServerRequest(id, {
      output: result ? result.stdout + result.stderr : "",
      exitCode: result?.exitCode ?? 0,
      isComplete: true,
    });
  }

  private handleTerminalWaitForExit(id: number | string, params: Record<string, unknown>): void {
    const termId = params.terminalId as string;
    const result = this.terminalResults.get(termId);
    this.rpc?.respondToServerRequest(id, { exitCode: result?.exitCode ?? 0 });
  }

  private handleTerminalRelease(id: number | string, params: Record<string, unknown>): void {
    const termId = params.terminalId as string;
    this.terminalResults.delete(termId);
    this.rpc?.respondToServerRequest(id, {});
  }

  private handleExit(code: number | null, _signal: string | null): void {
    this.clearWatchdog();
    this.rpc?.rejectAll("Process exited");

    if (this.state !== "ended") {
      this.setState("ended");
      if (code !== 0 && code !== null) {
        this.emit({
          type: "session:error",
          errors: [`ACP agent process exited with code ${code}`],
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
      this.proc?.kill();
      this.rpc?.rejectAll("Watchdog timeout");
      if (this.state !== "ended") {
        this.setState("ended");
        this.emit({
          type: "session:error",
          errors: [`ACP agent watchdog timeout — no events for ${Math.round(this.watchdogTimeoutMs / 1000)}s`],
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
