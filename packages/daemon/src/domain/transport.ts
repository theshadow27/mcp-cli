/**
 * The worker's half of the link.
 *
 * `WorkerServerTransport` with the same wire check the daemon applies on its
 * side. Checking only one direction would have been the exact failure this epic
 * keeps producing — an invariant honoured where a review pointed rather than
 * everywhere it applies. A tool result carrying a `Date` travels perfectly
 * across `postMessage` and arrives as a string over a socket; the producer is
 * where that should fail, because the producer is the only side that can still
 * say which field it was.
 *
 * And saying which field it was is the whole point, which is why a failure here
 * is **answered, not thrown**. The MCP SDK awaits `transport.send(response)`
 * inside a `.catch(err => this._onerror(err))`, so a throw is swallowed: no
 * response frame, no error frame, and the request expires on the requester's own
 * timeout. The caller is then told "Request timed out" — sending whoever is
 * debugging after worker health instead of after `$.result.isError: undefined`.
 */

import { type DomainWorkerMessage, WireUnsafeError, assertWireSafe, findWireUnsafeValue } from "@mcp-cli/core";
import type { TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { WIRE_UNSAFE_ERROR_CODE, requestIdOf } from "../domain-link";
import { WorkerServerTransport } from "../worker-transport";

export class DomainWorkerTransport extends WorkerServerTransport {
  override async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const problem = findWireUnsafeValue(message);
    if (problem === null) return super.send(message, options);

    const failed = new WireUnsafeError("domain worker jsonrpc send", problem);
    const id = requestIdOf(message);
    if (id === null) {
      // A notification: there is nothing to answer, so the only way this reaches
      // a human is the worker's stderr, which the daemon persists per session.
      console.error(`[domain-worker] dropping unsendable notification — ${failed.message}`);
      throw failed;
    }
    return super.send(
      { jsonrpc: "2.0", id, error: { code: WIRE_UNSAFE_ERROR_CODE, message: failed.message } } as JSONRPCMessage,
      options,
    );
  }
}

/**
 * Wire-check a control message on its way from the worker to the daemon.
 *
 * Extracted from the worker entrypoint so it can be tested at all: the worker
 * only ever posts `ready` and `error`, both wire-safe by construction, so the
 * check inside it could be deleted with the whole suite staying green — one of
 * the two rows in the PR body's four-row table that had prose behind it rather
 * than enforcement. The check still belongs on the producer, which is the only
 * side that can name the field.
 */
export function checkedControlMessage(message: DomainWorkerMessage): DomainWorkerMessage {
  return assertWireSafe(message, `domain worker control message "${message.type}"`);
}
