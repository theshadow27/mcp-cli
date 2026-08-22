/**
 * A domain worker that exits *cleanly* once connected.
 *
 * The distinction from `crashing-domain-worker.ts` is the entire point: a thread
 * that throws fires `error`, while one that calls `process.exit()` — or whose
 * event loop simply drains — fires `close` and nothing else. A link that wires
 * only `onerror` never hears about this one, so the supervisor keeps reporting
 * `running` for a worker that no longer exists, forever.
 *
 * #3044 puts arbitrary project code in this thread, where `process.exit` is an
 * ordinary thing for a script to do.
 *
 * Speaks just enough protocol to get connected — `ready`, then the MCP
 * `initialize` handshake — and exits on the `notifications/initialized` that
 * follows, so the exit is triggered by a message rather than by a timer.
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
        serverInfo: { name: "exiting-domain-worker", version: "0.0.0" },
      },
    });
    return;
  }

  if (data?.method === "notifications/initialized") {
    process.exit(0);
  }
};
