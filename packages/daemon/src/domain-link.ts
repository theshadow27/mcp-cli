/**
 * The link to a domain worker — the one place that knows *how* the worker is
 * reached, so that nothing above it does.
 *
 * `DomainServer` supervises a domain worker without ever naming `Worker`,
 * `postMessage` or a thread. It sends control messages, it sends JSON-RPC over a
 * transport, and it is told when the link fails. Every one of those verbs has an
 * identical meaning over a socket, which is what makes "a domain moves to
 * another host" a second implementation of this interface rather than a rewrite
 * of the supervisor.
 *
 * The rules this interface exists to hold:
 *
 * - **No synchronous call-and-return.** `postControl` is fire-and-forget; every
 *   answer arrives asynchronously through `onControl` or over the transport.
 * - **No object references across the boundary.** Everything sent is checked
 *   with `assertWireSafe`, so a `Date`, a `Map`, a closure or a cycle fails here
 *   — loudly, at the send — instead of silently degrading the day the link is a
 *   socket and structured clone is no longer doing the work.
 * - **Failure is a first-class event.** A worker that dies mid-request and a
 *   socket that drops mid-request are the same event to the layer above, and in
 *   both cases in-flight requests must be rejected rather than left hanging.
 */

import {
  type DomainControlMessage,
  type DomainSnapshot,
  type DomainWorkerMessage,
  WireUnsafeError,
  assertWireSafe,
  findWireUnsafeValue,
  isDomainWorkerMessage,
  isJsonRpcMessage,
} from "@mcp-cli/core";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { workerPath } from "./worker-path";

/**
 * A live connection to one domain worker.
 *
 * Implementations: {@link createWorkerDomainLink} (a Bun Worker in this process)
 * and, when a domain grows a `host`, a socket to the machine that owns it.
 */
export interface DomainLink {
  /** Send one control message. Asynchronous by construction: replies arrive via {@link onControl}. */
  postControl(message: DomainControlMessage): void;
  /** Control messages from the far side. Set before the link is used. */
  onControl: ((message: DomainWorkerMessage) => void) | null;
  /** The link failed: the worker died, the socket dropped, the far side sent nonsense. */
  onFailure: ((reason: string) => void) | null;
  /** MCP JSON-RPC carried over the same link. */
  readonly transport: Transport;
  /** Tear the link down. Idempotent; rejects nothing, throws nothing. */
  close(): Promise<void>;
}

/** Creates a link for one domain. Injectable so supervision is testable without spawning threads. */
export type DomainLinkFactory = (domain: DomainSnapshot) => DomainLink;

/**
 * Transport half of a link: carries JSON-RPC frames that the owning link
 * demultiplexes from control traffic.
 */
class DomainLinkTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;
  private closeEmitted = false;

  constructor(
    private readonly sendRaw: (message: JSONRPCMessage) => void,
    private readonly onTeardown: () => Promise<void>,
  ) {}

  async start(): Promise<void> {
    // The link is already listening — it has to be, to receive the `ready`
    // handshake that happens before any MCP client connects.
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const problem = findWireUnsafeValue(message);
    if (problem !== null) {
      // Throwing here reaches the MCP SDK's `.catch(e => this._onerror(e))` and
      // dies there: the request then expires on its own timeout and the caller
      // is told "Request timed out", which sends whoever is debugging after
      // worker health instead of after the offending field. The guard's entire
      // value is the field name, so it has to travel back to the requester.
      const failed = new WireUnsafeError("domain jsonrpc send", problem);
      const id = requestIdOf(message);
      if (id === null) throw failed;
      this.deliver({
        jsonrpc: "2.0",
        id,
        error: { code: WIRE_UNSAFE_ERROR_CODE, message: failed.message },
      } as JSONRPCMessage);
      return;
    }
    this.sendRaw(message);
  }

  async close(): Promise<void> {
    // Not the same as `closed()`: the MCP Client calls this on its own teardown
    // paths, and a transport that reports closure without stopping the far side
    // leaves a live worker behind reporting `running`. `WorkerClientTransport`
    // terminates here; two client-side worker transports with opposite close
    // semantics is a trap for the next author.
    await this.onTeardown();
    this.closed();
  }

  /** Deliver an inbound frame. Called by the owning link. */
  deliver(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }

  /** Report a link-level error to the MCP client. */
  fail(error: Error): void {
    this.onerror?.(error);
  }

  /**
   * Report that the link is gone, which is what rejects in-flight requests.
   *
   * Idempotent: teardown can arrive from either side — the MCP Client closing
   * the transport, or the link observing the worker die — and the SDK should
   * see exactly one closure either way.
   */
  closed(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.onclose?.();
  }
}

/** JSON-RPC internal-error code, used when a frame cannot be put on the wire at all. */
export const WIRE_UNSAFE_ERROR_CODE = -32603;

/** The `id` of a request/response frame, or `null` for a notification (nothing to answer). */
export function requestIdOf(message: unknown): string | number | null {
  if (typeof message !== "object" || message === null) return null;
  const id = (message as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/** A short, bounded description of an unexpected payload — never the payload itself. */
function describe(data: unknown): string {
  if (data === null) return "null";
  if (typeof data !== "object") return typeof data;
  if (Array.isArray(data)) return `array(${data.length})`;
  return `object with keys [${Object.keys(data).slice(0, 5).join(", ")}]`;
}

/** A {@link DomainLink} backed by a Bun Worker in this process. */
class WorkerDomainLink implements DomainLink {
  onControl: ((message: DomainWorkerMessage) => void) | null = null;
  onFailure: ((reason: string) => void) | null = null;
  readonly transport: DomainLinkTransport;
  private closed = false;
  private exitHandler: (() => void) | null = null;

  constructor(private readonly worker: Worker) {
    this.transport = new DomainLinkTransport(
      (message) => {
        this.worker.postMessage(message);
      },
      () => this.close(),
    );

    this.worker.onmessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (isDomainWorkerMessage(data)) {
        this.onControl?.(data);
        return;
      }
      if (isJsonRpcMessage(data)) {
        this.transport.deliver(data as JSONRPCMessage);
        return;
      }
      // Neither control nor JSON-RPC. In-process this is a worker bug; over a
      // socket it is a peer speaking something else. Handing it to the MCP
      // client would produce a parse error with no provenance, so the link
      // fails instead — which is a supervised, restartable condition.
      this.fail(`unrecognized message on the domain link: ${describe(data)}`);
    };

    this.worker.onerror = (event: ErrorEvent | Event) => {
      this.fail(event instanceof ErrorEvent ? event.message : "unknown worker error");
    };

    // A worker that exits cleanly — `process.exit()`, or an event loop that
    // simply drains — fires `close` and never `error`. Without this listener the
    // supervisor never hears about it: no failure, no restart, and a state that
    // reads `running` forever over a channel that cannot carry the news. #3044
    // puts arbitrary project code in this thread, where `process.exit` is not
    // hypothetical.
    this.exitHandler = () => this.fail("worker exited");
    this.worker.addEventListener("close", this.exitHandler);
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.transport.fail(new Error(reason));
    // A dead link must also reject whatever was in flight on it. Without this a
    // raw link failure (as opposed to a supervised crash) leaves MCP requests
    // waiting for a response that can no longer arrive.
    this.transport.closed();
    this.onFailure?.(reason);
  }

  postControl(message: DomainControlMessage): void {
    assertWireSafe(message, `domain control message "${message.type}"`);
    this.worker.postMessage(message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onControl = null;
    this.onFailure = null;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    if (this.exitHandler) {
      // Removed before terminate(), so an intentional teardown does not come
      // back as a spurious "worker exited" failure.
      this.worker.removeEventListener("close", this.exitHandler);
      this.exitHandler = null;
    }
    try {
      this.worker.terminate();
    } catch {
      // already dead — terminate is best-effort, the link is gone either way
    }
    // Tell the MCP client the link is gone so in-flight requests reject instead
    // of waiting for a response that can no longer arrive.
    this.transport.closed();
  }
}

/**
 * Spawn a domain worker in this process and return the link to it.
 *
 * The domain is *not* passed to the constructor of the worker — a worker learns
 * which domain it serves from the `init` control message, exactly as it would
 * over a socket. Nothing here may become a shortcut that only works in-process.
 */
export function createWorkerDomainLink(
  _domain: DomainSnapshot,
  workerFactory: (scriptPath: string) => Worker = (scriptPath) => new Worker(scriptPath),
): DomainLink {
  // Spelled as a literal, not a constant: `daemon-workers.spec.ts` derives the
  // compiled-binary entrypoint list by scanning daemon source for string
  // arguments to this call, and a worker it cannot see is a worker missing from
  // `dist/mcpd`.
  return new WorkerDomainLink(workerFactory(workerPath("domain-worker.ts")));
}
