/**
 * MCP tool definitions for a domain worker.
 *
 * Single source of truth for both halves of the link: the worker registers
 * these, the daemon names them when it calls them. Project execution — phases,
 * automation, sensors, the reducer — lands here in #3044; what is here now is
 * the lifecycle surface, which is what the supervisor needs to tell a live
 * worker from a wedged one.
 */

export interface DomainToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

/** Cheapest possible liveness probe: no state, no I/O. */
export const DOMAIN_PING_TOOL = "domain_ping";

/** Which domain row this worker is bound to, as it was handed over at init. */
export const DOMAIN_INFO_TOOL = "domain_info";

export const DOMAIN_TOOLS: DomainToolDef[] = [
  {
    name: DOMAIN_PING_TOOL,
    description: "Liveness probe for a domain worker. Returns the bound domain id and the worker's uptime.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: DOMAIN_INFO_TOOL,
    description:
      "Describe the domain worker: the domain row it was bound to at init, the protocol version it speaks, " +
      "and the state of its no-HTTP guard.",
    inputSchema: { type: "object", properties: {} },
  },
];

export const DOMAIN_TOOL_NAMES: ReadonlySet<string> = new Set(DOMAIN_TOOLS.map((t) => t.name));
