/**
 * Typed HTTP client for the OpenCode REST API.
 *
 * Thin wrapper around fetch() for OpenCode's HTTP endpoints.
 * OpenCode uses standard HTTP — the simplest integration of all providers.
 */

export interface OpenCodeApiSession {
  id: string;
  status: "idle" | "busy" | "error";
}

export interface OpenCodeMessage {
  id: string;
  role: "user" | "assistant";
  parts: OpenCodeMessagePart[];
}

export type OpenCodeMessagePart =
  | { type: "text"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      state: "running" | "completed" | "error";
      input?: unknown;
      output?: string;
    }
  | { type: "step-finish"; tokens: { input: number; output: number; reasoning: number }; cost: number };

export interface OpenCodePermissionEvent {
  id: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
}

/** Default HTTP request timeout (30s). */
export const HTTP_TIMEOUT_MS = 30_000;

export class OpenCodeClient {
  constructor(private readonly baseUrl: string) {}

  /** Create a new session. */
  async createSession(opts?: { cwd?: string }): Promise<OpenCodeApiSession> {
    const res = await this.post("/session", { cwd: opts?.cwd });
    return res as OpenCodeApiSession;
  }

  /** Send a prompt to a session (blocking — returns when the turn completes). */
  async sendPrompt(sessionId: string, text: string): Promise<OpenCodeMessage> {
    const res = await this.post(`/session/${sessionId}/message`, { content: text });
    return res as OpenCodeMessage;
  }

  /** Send a prompt asynchronously (fire-and-forget, results via SSE). */
  async sendPromptAsync(sessionId: string, text: string): Promise<void> {
    await this.post(`/session/${sessionId}/message`, { content: text, async: true });
  }

  /** Abort the current operation in a session. */
  async abortSession(sessionId: string): Promise<void> {
    await this.post(`/session/${sessionId}/abort`, {});
  }

  /** Get session details. */
  async getSession(sessionId: string): Promise<OpenCodeApiSession> {
    const res = await this.get(`/session/${sessionId}`);
    return res as OpenCodeApiSession;
  }

  /** List all sessions. */
  async listSessions(): Promise<OpenCodeApiSession[]> {
    const res = await this.get("/session");
    return res as OpenCodeApiSession[];
  }

  /** Reply to a permission request. */
  async replyPermission(requestId: string, reply: "once" | "always" | "reject"): Promise<void> {
    await this.post(`/permission/${requestId}/reply`, { decision: reply });
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenCode API ${res.status}: ${res.statusText} ${body}`);
    }
    return res.json();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenCode API ${res.status}: ${res.statusText} ${text}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return res.json();
    }
    return undefined;
  }
}
