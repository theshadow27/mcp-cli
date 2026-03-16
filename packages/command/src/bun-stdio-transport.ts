/**
 * Bun-native stdio MCP server transport.
 *
 * The SDK's StdioServerTransport relies on Node.js stream events
 * (process.stdin.on('data')) which don't fire reliably in Bun,
 * especially in compiled binaries. This transport uses Bun's native
 * ReadableStream API to read stdin instead.
 */

import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export class BunStdioServerTransport implements Transport {
  private _started = false;
  private _reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private _buffer = "";
  private _aborted = false;
  private _closedResolve!: () => void;

  /** Resolves when the transport is closed (stdin EOF or explicit close). */
  readonly closed: Promise<void>;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private _stdin: ReadableStream<Uint8Array> = Bun.stdin.stream(),
    private _stdout: { write(data: string): boolean | number } = process.stdout,
  ) {
    this.closed = new Promise((resolve) => {
      this._closedResolve = resolve;
    });
  }

  async start(): Promise<void> {
    if (this._started) {
      throw new Error("BunStdioServerTransport already started!");
    }
    this._started = true;
    this._reader = this._stdin.getReader();
    this._readLoop();
  }

  private async _readLoop(): Promise<void> {
    const reader = this._reader;
    if (!reader) return;

    const decoder = new TextDecoder();
    try {
      while (!this._aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        this._buffer += decoder.decode(value, { stream: true });
        this._processBuffer();
      }
    } catch (err) {
      if (!this._aborted) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
    // stdin closed — trigger transport close
    if (!this._aborted) {
      await this.close();
    }
  }

  private _processBuffer(): void {
    while (true) {
      const newlineIdx = this._buffer.indexOf("\n");
      if (newlineIdx === -1) break;

      const line = this._buffer.slice(0, newlineIdx).replace(/\r$/, "");
      this._buffer = this._buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const message = deserializeMessage(line);
        this.onmessage?.(message);
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const json = serializeMessage(message);
    this._stdout.write(json);
  }

  async close(): Promise<void> {
    this._aborted = true;
    try {
      this._reader?.releaseLock();
    } catch {
      // reader may already be released
    }
    this._reader = null;
    this._buffer = "";
    this.onclose?.();
    this._closedResolve();
  }
}
