/**
 * A domain worker that dies as soon as it is connected.
 *
 * Used by `domain-worker.spec.ts` to prove the supervision path against a real
 * Bun Worker: that an actual worker death reaches `DomainLink.onFailure`, and
 * that the restart policy then runs. The fake link in `test-helpers.ts` proves
 * the supervisor's decisions; this proves the plumbing underneath them.
 *
 * It speaks exactly enough of the protocol to get connected — `ready`, then the
 * MCP `initialize` handshake — and throws on the `notifications/initialized`
 * that follows. Crashing on a message rather than on a timer keeps the test a
 * test of the CONDITION and not of time passing.
 */

import { AGENT_PROTOCOL_VERSION } from "@mcp-cli/core";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

declare const self: Worker;

self.onmessage = (event: MessageEvent): void => {
  const data = event.data as { type?: string; method?: string; id?: unknown; domain?: { id: number } };

  if (data?.type === "init") {
    self.postMessage({
      type: "ready",
      supported_protocol_version: AGENT_PROTOCOL_VERSION,
      domain_id: data.domain?.id ?? 0,
    });
    return;
  }

  if (data?.method === "initialize") {
    self.postMessage({
      jsonrpc: "2.0",
      id: data.id,
      result: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "crashing-domain-worker", version: "0.0.0" },
      },
    });
    return;
  }

  if (data?.method === "notifications/initialized") {
    throw new Error("simulated domain worker crash");
  }
};
