/**
 * Bun.spawn wrapper for the Codex App Server process.
 *
 * Spawns `codex app-server` with piped stdio, line-buffers stdout,
 * and parses each line as JSON. Emits parsed messages via callback
 * and reports process exit.
 */

import type { Subprocess } from "bun";

export interface CodexProcessOptions {
  /** Working directory for the codex process. */
  cwd: string;
  /** Extra environment variables merged with process.env. */
  env?: Record<string, string>;
  /** Override the command (defaults to ["codex", "app-server"]). */
  command?: string[];
  /** Called for each parsed JSONL message from stdout. */
  onMessage: (msg: Record<string, unknown>) => void;
  /** Called when the process exits. */
  onExit: (code: number | null, signal: string | null) => void;
  /** Called on parse errors (malformed JSONL lines). */
  onError?: (error: Error, rawLine: string) => void;
  /** Called with stderr chunks. */
  onStderr?: (chunk: string) => void;
}

export class CodexProcess {
  private proc: Subprocess | null = null;
  private readonly opts: CodexProcessOptions;
  private _exited = false;
  private readLoopPromise: Promise<void> | null = null;
  private stderrLoopPromise: Promise<void> | null = null;

  constructor(opts: CodexProcessOptions) {
    this.opts = opts;
  }

  /** Spawn the codex app-server process. */
  spawn(): void {
    if (this.proc) throw new Error("CodexProcess already spawned");

    const cmd = this.opts.command ?? ["codex", "app-server"];
    this.proc = Bun.spawn(cmd, {
      cwd: this.opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: this.opts.onStderr ? "pipe" : "inherit",
      env: { ...process.env, ...this.opts.env },
    });

    // Start reading stdout lines
    this.readLoopPromise = this.readLines();

    // Start reading stderr if requested
    if (this.opts.onStderr && this.proc.stderr) {
      this.stderrLoopPromise = this.readStderr();
    }

    // Monitor process exit
    this.proc.exited.then((code) => {
      if (this._exited) return;
      this._exited = true;
      this.opts.onExit(code, null);
    });
  }

  /** Write a JSON-RPC message to the process stdin and flush. */
  async write(msg: Record<string, unknown>): Promise<void> {
    const stdin = this.proc?.stdin;
    if (!stdin || typeof stdin === "number") throw new Error("Process not spawned or stdin unavailable");
    const line = `${JSON.stringify(msg)}\n`;
    stdin.write(line);
    await stdin.flush();
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

  /** Read stdout line by line and parse as JSON. */
  private async readLines(): Promise<void> {
    const stdout = this.proc?.stdout;
    if (!stdout || typeof stdout === "number") return;

    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last partial line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            this.opts.onMessage(parsed);
          } catch (err) {
            this.opts.onError?.(err instanceof Error ? err : new Error(String(err)), trimmed);
          }
        }
      }

      // Process any remaining buffer content
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer.trim()) as Record<string, unknown>;
          this.opts.onMessage(parsed);
        } catch (err) {
          this.opts.onError?.(err instanceof Error ? err : new Error(String(err)), buffer.trim());
        }
      }
    } catch (err) {
      // Stream closed unexpectedly — process likely died
      if (!this._exited) {
        this.opts.onError?.(err instanceof Error ? err : new Error(String(err)), "");
      }
    }
  }

  /** Read stderr chunks. */
  private async readStderr(): Promise<void> {
    const stderr = this.proc?.stderr;
    if (!stderr) return;

    const reader = (stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.opts.onStderr?.(decoder.decode(value, { stream: true }));
      }
    } catch {
      // Stream closed — ignore
    }
  }
}
