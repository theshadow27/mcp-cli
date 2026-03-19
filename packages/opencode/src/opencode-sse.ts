/**
 * SSE (Server-Sent Events) consumer for OpenCode's event stream.
 *
 * Connects to `GET /event?directory=...` and routes events to handlers.
 * Unlike ACP (NDJSON over stdio), OpenCode streams events via standard SSE.
 */

export interface OpenCodeSseEvent {
  type: string;
  data: Record<string, unknown>;
}

export type SseEventHandler = (event: OpenCodeSseEvent) => void;

export interface OpenCodeSseOptions {
  /** Base URL of the OpenCode server. */
  baseUrl: string;
  /** Working directory to subscribe events for. */
  cwd: string;
  /** Called for each parsed SSE event. */
  onEvent: SseEventHandler;
  /** Called when the connection closes. */
  onClose?: () => void;
  /** Called on connection errors. */
  onError?: (error: Error) => void;
}

export class OpenCodeSse {
  private abortController: AbortController | null = null;
  private readonly opts: OpenCodeSseOptions;
  private _connected = false;

  constructor(opts: OpenCodeSseOptions) {
    this.opts = opts;
  }

  /** Start consuming the SSE stream. */
  async connect(): Promise<void> {
    if (this.abortController) throw new Error("Already connected");

    this.abortController = new AbortController();
    const url = `${this.opts.baseUrl}/event?directory=${encodeURIComponent(this.opts.cwd)}`;

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { accept: "text/event-stream" },
        signal: this.abortController.signal,
      });

      if (!res.ok) {
        throw new Error(`SSE connect failed: ${res.status} ${res.statusText}`);
      }

      if (!res.body) {
        throw new Error("SSE response has no body");
      }

      this._connected = true;
      this.consumeStream(res.body);
    } catch (err) {
      if (this.isAbortError(err)) return;
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Disconnect from the SSE stream. */
  disconnect(): void {
    this._connected = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  /** Whether the SSE stream is connected. */
  get connected(): boolean {
    return this._connected;
  }

  private async consumeStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by double newlines
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const raw of events) {
          const parsed = parseSseEvent(raw);
          if (parsed) {
            this.opts.onEvent(parsed);
          }
        }
      }
    } catch (err) {
      if (!this.isAbortError(err)) {
        this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this._connected = false;
      this.opts.onClose?.();
    }
  }

  private isAbortError(err: unknown): boolean {
    return err instanceof DOMException && err.name === "AbortError";
  }
}

/**
 * Parse a raw SSE event block into a typed event.
 *
 * SSE format:
 *   event: <type>
 *   data: <json>
 *
 * If no event: field, defaults to "message".
 */
export function parseSseEvent(raw: string): OpenCodeSseEvent | null {
  const lines = raw.split("\n");
  let eventType = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    } else if (line.startsWith(":")) {
      // Comment — ignore
    }
  }

  if (dataLines.length === 0) return null;

  const dataStr = dataLines.join("\n");
  try {
    const data = JSON.parse(dataStr) as Record<string, unknown>;
    return { type: eventType, data };
  } catch {
    // Non-JSON data — wrap as text
    return { type: eventType, data: { text: dataStr } };
  }
}
