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
 */

import { assertWireSafe } from "@mcp-cli/core";
import type { TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { WorkerServerTransport } from "../worker-transport";

export class DomainWorkerTransport extends WorkerServerTransport {
  override async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    assertWireSafe(message, "domain worker jsonrpc send");
    return super.send(message, options);
  }
}
