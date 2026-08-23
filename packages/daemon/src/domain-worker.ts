/**
 * Bun Worker hosting one domain.
 *
 * One worker per registered domain. It runs that domain's project code — phases,
 * automation, sensors, the reducer — so that a project crash restarts one domain
 * instead of taking `mcpd` down with it. Project execution itself moves here in
 * #3044; this file is the lifecycle and the control protocol.
 *
 * Two properties this file is responsible for, both enforced rather than
 * described:
 *
 * 1. **It serves no HTTP**, in two layers because one is not enough. The seal
 *    runs as an import side effect (`./domain/autoseal`, deliberately the first
 *    import) so it precedes the rest of this module's import graph — a seal in
 *    the `init` handler would run *after* every module here had evaluated, and a
 *    module-scope `const f = Bun.serve` taken before it keeps working. Then at
 *    bind time the property is **verified** by attempting to listen, and the
 *    worker refuses to start if a listener opens. The console worker is the
 *    process that serves HTTP (epic H); keeping them apart is what stops a
 *    crashing page from taking down project execution.
 * 2. **It knows nothing this process told it out-of-band.** Its entire binding
 *    is the `init` message — no shared database handle, no object references, no
 *    module-level reach into daemon state. A worker for a domain on another host
 *    receives exactly this message over a socket and behaves identically.
 *
 * Protocol (docs/agent-protocol.md):
 *   1. Daemon sends: { type: "init", protocol_version, daemonId, domain }
 *   2. Worker verifies it cannot listen, starts its MCP server, replies: { type: "ready", domain_id }
 *   3. MCP JSON-RPC in both directions from then on.
 */

// FIRST import, deliberately: this seals the listener entry points as a side
// effect of evaluation, and ESM evaluates imports in order before any statement
// below. A `sealNoHttp()` call in the init handler would run after every module
// here had already captured its bindings. See ./domain/autoseal.
import "./domain/autoseal";
import {
  AGENT_PROTOCOL_VERSION,
  type DomainInitMessage,
  type DomainSnapshot,
  type DomainWorkerMessage,
} from "@mcp-cli/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { validateDomainSnapshot } from "./domain/bind";
import { DOMAIN_INFO_TOOL, DOMAIN_PING_TOOL, DOMAIN_TOOLS, DOMAIN_TOOL_NAMES } from "./domain/tools";
import { DomainWorkerTransport, checkedControlMessage } from "./domain/transport";
import { HttpStillReachableError, verifyCannotListen } from "./no-http";
import { createIsControlMessage } from "./worker-control-message";

// ── Control messages ──
// The daemon→worker vocabulary for this worker. Kept as a local Set so the
// agent-protocol-appendix-sync rule can derive the wire inventory from source.

type ControlMessage = DomainInitMessage;
const CONTROL_MESSAGE_TYPES: ReadonlySet<string> = new Set<ControlMessage["type"]>(["init"]);
const isControlMessage = createIsControlMessage<ControlMessage>(CONTROL_MESSAGE_TYPES);

declare const self: Worker;

// A `type` and not an `interface`: the SDK's ServerResult is an index-signature
// type, and only a type alias gets the implicit index signature that satisfies it.
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/**
 * Send a control message back to the daemon, wire-checked.
 *
 * Same check as the daemon's send path, in the other direction — the whole
 * point being that neither end may rely on structured clone.
 */
function postControl(message: DomainWorkerMessage): void {
  self.postMessage(checkedControlMessage(message));
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// ── Worker state ──
// Everything here is derived from `init` and dies with the worker. State that
// must outlive a restart lives in the database, because a restart is the same
// event as a move to another host, and memory does not move.

let mcpServer: Server | null = null;
let transport: DomainWorkerTransport | null = null;
let domain: DomainSnapshot | null = null;
let daemonId: string | null = null;
let startedAt = 0;
/**
 * Whether this thread was *observed* to be unable to open a listening socket,
 * established once at bind time by actually attempting it. Reporting the marker
 * instead would mean `guards.http` says "a flag is set" while a pre-seal
 * reference could still open a port — and #3045's rule would pass on exactly
 * the worker it exists to catch.
 */
let listenVerified = false;

function requireDomain(): DomainSnapshot {
  if (!domain) throw new Error("domain worker is not bound — no init message received");
  return domain;
}

function handlePing(): ToolResult {
  const d = requireDomain();
  return ok({ ok: true, domainId: d.id, uptimeMs: Math.max(0, Date.now() - startedAt) });
}

function handleInfo(): ToolResult {
  const d = requireDomain();
  return ok({
    domain: d,
    daemonId,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    startedAt,
    uptimeMs: Math.max(0, Date.now() - startedAt),
    // "sealed" means a bind was attempted in this thread and refused — the
    // property itself, not a marker standing in for it.
    guards: { http: listenVerified ? "sealed" : "unverified" },
  });
}

function dispatch(name: string): ToolResult {
  if (!DOMAIN_TOOL_NAMES.has(name)) return toolError(`Unknown tool: ${name}`);
  try {
    switch (name) {
      case DOMAIN_PING_TOOL:
        return handlePing();
      case DOMAIN_INFO_TOOL:
        return handleInfo();
      default:
        return toolError(`Unhandled tool: ${name}`);
    }
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

async function startServer(bound: DomainSnapshot): Promise<void> {
  mcpServer = new Server({ name: `_domain:${bound.name}`, version: "0.1.0" }, { capabilities: { tools: {} } });

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: DOMAIN_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => dispatch(request.params.name));

  transport = new DomainWorkerTransport(self);
  await mcpServer.connect(transport);

  // The transport claimed `self.onmessage` during connect; wrap it so control
  // messages are handled here and everything else continues to the transport.
  const transportHandler = self.onmessage;
  self.onmessage = (event: MessageEvent): void => {
    if (isControlMessage(event.data)) {
      // `init` is the first and only control message today; a second one is a
      // supervisor bug, and rebinding a live worker to a different domain is the
      // exact misbinding validateDomainSnapshot exists to prevent.
      console.error(`[domain-worker] ignoring duplicate control message on a bound worker (domain ${bound.name})`);
      return;
    }
    transportHandler?.call(self, event);
  };
}

self.onmessage = async (event: MessageEvent): Promise<void> => {
  const data: unknown = event.data;
  if (!isControlMessage(data) || data.type !== "init") return;
  try {
    // The seal itself already ran at import time (./domain/autoseal). What
    // happens here is the *verification*: attempt a bind and refuse to start if
    // one succeeds. A worker that can listen must not come up reporting healthy.
    const verification = verifyCannotListen();
    if (verification.canListen) throw new HttpStillReachableError(verification);
    listenVerified = true;
    const bound = validateDomainSnapshot(data.domain);
    domain = bound;
    daemonId = typeof data.daemonId === "string" ? data.daemonId : null;
    startedAt = Date.now();
    await startServer(bound);
    postControl({ type: "ready", supported_protocol_version: AGENT_PROTOCOL_VERSION, domain_id: bound.id });
  } catch (err) {
    mcpServer = null;
    transport = null;
    domain = null;
    postControl({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
