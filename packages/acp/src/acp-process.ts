/**
 * Bun.spawn wrapper for ACP agent processes.
 *
 * Spawns an ACP-compatible CLI (e.g. `gh copilot --acp`) with piped stdio,
 * line-buffers stdout, and parses each line as JSON. Emits parsed messages
 * via callback and reports process exit.
 *
 * Mirrors codex-process.ts but for the ACP protocol.
 */

import type { Subprocess } from "bun";

export interface AcpProcessOptions {
  /** Working directory for the agent process. */
  cwd: string;
  /** Command + args to spawn (e.g. ["gh", "copilot", "--acp"]). */
  command: string[];
  /** Extra environment variables merged with process.env. */
  env?: Record<string, string>;
  /** Called for each parsed NDJSON message from stdout. */
  onMessage: (msg: Record<string, unknown>) => void;
  /** Called when the process exits. */
  onExit: (code: number | null, signal: string | null) => void;
  /** Called on parse errors (malformed NDJSON lines). */
  onError?: (error: Error, rawLine: string) => void;
  /** Called with stderr chunks. */
  onStderr?: (chunk: string) => void;
}

export class AcpProcess {
  private proc: Subprocess | null = null;
  private readonly opts: AcpProcessOptions;
  private _exited = false;

  constructor(opts: AcpProcessOptions) {
    this.opts = opts;
  }

  /** Spawn the ACP agent process. */
  spawn(): void {
    if (this.proc) throw new Error("AcpProcess already spawned");

    this.proc = Bun.spawn(this.opts.command, {
      cwd: this.opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: this.opts.onStderr ? "pipe" : "inherit",
      env: { ...process.env, ...this.opts.env },
    });

    // Start reading stdout lines
    this.readLines();

    // Start reading stderr if requested
    if (this.opts.onStderr && this.proc.stderr) {
      this.readStderr();
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
