/**
 * Bun.spawn wrapper for the OpenCode agent process.
 *
 * Spawns `opencode serve --hostname=127.0.0.1 --port=0` with piped stdout,
 * reads stdout line-by-line until the server URL is discovered, and provides
 * the base URL for the HTTP client.
 *
 * Unlike ACP (NDJSON over stdio), OpenCode uses HTTP REST + SSE — we only
 * need stdout for URL discovery, then communication moves to HTTP.
 */

import type { Subprocess } from "bun";

/** Default timeout for URL discovery from stdout (30s). */
export const URL_DISCOVERY_TIMEOUT_MS = 30_000;

/** Pattern to match the server listening line. */
const URL_PATTERN = /https?:\/\/127\.0\.0\.1:\d+/;

export interface OpenCodeProcessOptions {
  /** Working directory for the agent process. */
  cwd: string;
  /** Extra environment variables merged with process.env. */
  env?: Record<string, string>;
  /** Timeout for URL discovery in ms. Defaults to URL_DISCOVERY_TIMEOUT_MS. */
  discoveryTimeoutMs?: number;
  /** Called when the process exits. */
  onExit?: (code: number | null, signal: string | null) => void;
}

export class OpenCodeProcess {
  private proc: Subprocess | null = null;
  private _exited = false;
  private _baseUrl: string | null = null;
  private readonly opts: OpenCodeProcessOptions;

  constructor(opts: OpenCodeProcessOptions) {
    this.opts = opts;
  }

  /**
   * Spawn the OpenCode server process and discover its URL.
   * Returns the base URL (e.g. "http://127.0.0.1:12345").
   */
  async spawn(): Promise<string> {
    if (this.proc) throw new Error("OpenCodeProcess already spawned");

    this.proc = Bun.spawn(["opencode", "serve", "--hostname=127.0.0.1", "--port=0"], {
      cwd: this.opts.cwd,
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, ...this.opts.env },
    });

    // Monitor process exit
    this.proc.exited.then((code) => {
      if (this._exited) return;
      this._exited = true;
      this.opts.onExit?.(code, null);
    });

    // Discover URL from stdout
    const timeoutMs = this.opts.discoveryTimeoutMs ?? URL_DISCOVERY_TIMEOUT_MS;
    const stdout = this.proc.stdout;
    if (!stdout || typeof stdout === "number") {
      throw new Error("stdout not available");
    }
    this._baseUrl = await discoverUrl(stdout, timeoutMs);
    return this._baseUrl;
  }

  /** The discovered base URL. */
  get baseUrl(): string | null {
    return this._baseUrl;
  }

  /** Send SIGTERM to the process. */
  kill(): void {
    if (!this.proc || this._exited) return;
    this.proc.kill("SIGTERM");
  }

  /** Whether the process is still running. */
  get alive(): boolean {
    return this.proc !== null && !this._exited;
  }

  /** The process PID, if spawned. */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** Whether the process has exited. */
  get exited(): boolean {
    return this._exited;
  }
}

/**
 * Read stdout line-by-line until a URL matching the pattern is found.
 * Throws on timeout.
 */
export async function discoverUrl(stdout: ReadableStream<Uint8Array> | null, timeoutMs: number): Promise<string> {
  if (!stdout) throw new Error("No stdout stream available");

  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reader.releaseLock();
      reject(new Error(`URL discovery timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            clearTimeout(timer);
            reject(new Error("Process stdout closed before URL was discovered"));
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const match = line.match(URL_PATTERN);
            if (match) {
              clearTimeout(timer);
              resolve(match[0]);
              return;
            }
          }

          // Check partial buffer too
          const match = buffer.match(URL_PATTERN);
          if (match) {
            clearTimeout(timer);
            resolve(match[0]);
            return;
          }
        }
      } catch (err) {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });
}
