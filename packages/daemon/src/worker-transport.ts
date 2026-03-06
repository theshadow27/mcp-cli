/**
 * MCP Transport adapters for Bun Worker postMessage boundary.
 *
 * WorkerClientTransport — used in the main thread, wraps a Worker instance.
 * WorkerServerTransport — used inside the Worker, wraps `self`.
 *
 * Together they let a standard MCP Client (main thread) talk to an MCP Server
 * (worker thread) over the Worker postMessage channel.
 */

import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * Client-side transport: sits in the main thread, sends/receives via Worker.
 */
export class WorkerClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  constructor(private worker: Worker) {}

  async start(): Promise<void> {
    this.worker.onmessage = (event: MessageEvent) => {
      this.onmessage?.(event.data as JSONRPCMessage);
    };
    this.worker.onerror = (event: ErrorEvent | Event) => {
      const err = event instanceof ErrorEvent ? new Error(event.message) : new Error(String(event));
      this.onerror?.(err);
    };
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    this.worker.postMessage(message);
  }

  async close(): Promise<void> {
    this.worker.terminate();
    this.onclose?.();
  }
}

/**
 * Server-side transport: sits inside the Worker, sends/receives via `self`.
 */
export class WorkerServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  constructor(private self: Worker) {}

  async start(): Promise<void> {
    this.self.onmessage = (event: MessageEvent) => {
      this.onmessage?.(event.data as JSONRPCMessage);
    };
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    this.self.postMessage(message);
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}
