/**
 * Bun.spawn wrapper for ACP agent processes.
 *
 * Spawns an ACP-compatible CLI (e.g. `gh copilot --acp`) with piped stdio,
 * line-buffers stdout, and parses each line as JSON. Emits parsed messages
 * via callback and reports process exit.
 *
 * Mirrors codex-process.ts but for the ACP protocol.
 */

import { type ManagedHandle, spawnManaged } from "@mcp-cli/core";

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
  private handle: ManagedHandle | null = null;
  private readonly opts: AcpProcessOptions;
  private _exited = false;

  constructor(opts: AcpProcessOptions) {
    this.opts = opts;
  }

  /** Spawn the ACP agent process. */
  spawn(): void {
    if (this.handle) throw new Error("AcpProcess already spawned");

    const [bin, ...args] = this.opts.command;
    const result = spawnManaged(bin, args, {
      cwd: this.opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: this.opts.onStderr ? "pipe" : "inherit",
      onStderr: this.opts.onStderr,
      env: { ...process.env, ...this.opts.env },
    });

    if (!result.ok) {
      this._exited = true;
      this.opts.onExit(null, null);
      return;
    }

    this.handle = result.handle;

    this.readLines();

    this.handle.exited.then((status) => {
      if (this._exited) return;
      this._exited = true;
      this.opts.onExit(status.exitCode, status.signal);
    });
  }

  /** Write a JSON-RPC message to the process stdin and flush. */
  async write(msg: Record<string, unknown>): Promise<void> {
    const stdin = this.handle?.stdin;
    if (!stdin) throw new Error("Process not spawned or stdin unavailable");
    const line = `${JSON.stringify(msg)}\n`;
    stdin.write(line);
    await stdin.flush();
  }

  /** Send SIGTERM to the process. */
  kill(): void {
    if (!this.handle || this._exited) return;
    this.handle.kill();
  }

  /** Whether the process is still running. */
  get alive(): boolean {
    return this.handle !== null && !this._exited;
  }

  /** The process PID, if spawned. */
  get pid(): number | undefined {
    return this.handle?.pid;
  }

  /** Whether the process has exited. */
  get exited(): boolean {
    return this._exited;
  }

  /** Read stdout line by line and parse as JSON. */
  private async readLines(): Promise<void> {
    const stdout = this.handle?.stdout;
    if (!stdout) return;

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
}
