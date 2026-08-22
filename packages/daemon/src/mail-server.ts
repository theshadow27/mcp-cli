/**
 * Virtual MCP server that exposes daemon mail as MCP tools.
 *
 * Uses an in-process MCP Server with InMemoryTransport (no Workers).
 * Tools map 1:1 to the IPC mail handlers: sendMail, readMail, waitForMail, replyToMail.
 */

import type { ToolInfo } from "@mcp-cli/core";
import { MAIL_SERVER_NAME } from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { StateDb } from "./db/state";
import type { EventBus } from "./event-bus";
import { resolveCallerDomain, resolveDelivery } from "./mail-domain";
import { publishMailSent } from "./mail-events";

/**
 * Domain scope, on every mail tool (#3038).
 *
 * The MCP server is one in-process instance shared by every session, so it has no
 * ambient notion of "who is calling" — which is precisely why the caller must say. An
 * agent supplies its own `cwd`; `domain` names one explicitly. Neither supplied is an
 * error, not a fallback to the daemon's cwd.
 */
const SCOPE_PROPERTIES = {
  cwd: {
    type: "string",
    description: "Your working directory — resolved to a domain through the domains table. Required unless `domain`.",
  },
  domain: {
    type: "string",
    description:
      "Explicit domain name, e.g. 'phoenix'. \"_\" is the unassigned partition. Wins over `cwd`. Required unless `cwd`.",
  },
} as const;

const TOOLS = [
  {
    name: "_mail_send",
    description:
      "Send a mail message to a recipient. A bare recipient is local to your domain; 'user@domain' addresses another.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sender: { type: "string", description: "Sender identifier (e.g. session name or role)" },
        recipient: { type: "string", description: "Recipient identifier — 'name' (local) or 'name@domain'" },
        subject: { type: "string", description: "Optional subject line" },
        body: { type: "string", description: "Message body" },
        replyTo: { type: "number", description: "ID of message being replied to, if any" },
        ...SCOPE_PROPERTIES,
      },
      required: ["sender", "recipient"],
    },
  },
  {
    name: "_mail_read",
    description: "Read messages from a mailbox in your domain.",
    inputSchema: {
      type: "object" as const,
      properties: {
        recipient: { type: "string", description: "Filter by recipient (omit for all)" },
        unreadOnly: { type: "boolean", description: "Return only unread messages (default false)" },
        limit: { type: "number", description: "Max messages to return" },
        ...SCOPE_PROPERTIES,
      },
    },
  },
  {
    name: "_mail_wait",
    description: "Block until a message arrives for the given recipient in your domain, or timeout expires.",
    inputSchema: {
      type: "object" as const,
      properties: {
        recipient: { type: "string", description: "Recipient to wait for" },
        timeout: { type: "number", description: "Timeout in seconds (default 30, max 30)" },
        ...SCOPE_PROPERTIES,
      },
    },
  },
  {
    name: "_mail_reply",
    description: "Reply to an existing message. Replies route back to the sender's domain.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "ID of the message to reply to" },
        sender: { type: "string", description: "Sender identifier for the reply" },
        body: { type: "string", description: "Reply body" },
        subject: { type: "string", description: "Optional subject override (defaults to Re: <original>)" },
        ...SCOPE_PROPERTIES,
      },
      required: ["id", "sender", "body"],
    },
  },
] as const;

/** Pull the domain scope out of a tool call's arguments. Shared by all four tools. */
function toolScope(a: Record<string, unknown>): { cwd?: string; domain?: string } {
  return {
    cwd: a.cwd !== undefined ? String(a.cwd) : undefined,
    domain: a.domain !== undefined ? String(a.domain) : undefined,
  };
}

export class MailServer {
  private server: Server | null = null;
  private client: Client | null = null;
  private serverTransport: Transport | null = null;
  private clientTransport: Transport | null = null;
  private stopped = false;

  constructor(
    private db: StateDb,
    private eventBus: EventBus | null = null,
  ) {}

  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  async start(): Promise<{ client: Client; transport: Transport; tools: Map<string, ToolInfo> }> {
    if (this.server) {
      throw new Error("MailServer already started");
    }

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    this.serverTransport = serverTransport;
    this.clientTransport = clientTransport;

    this.server = new Server({ name: MAIL_SERVER_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const a = args ?? {};

      try {
        switch (name) {
          case "_mail_send": {
            const sender = String(a.sender ?? "");
            const recipient = String(a.recipient ?? "");
            if (!sender || !recipient) {
              return { content: [{ type: "text" as const, text: "sender and recipient are required" }], isError: true };
            }
            const subject = a.subject !== undefined ? String(a.subject) : undefined;
            const body = a.body !== undefined ? String(a.body) : undefined;
            const replyTo = a.replyTo !== undefined ? Number(a.replyTo) : undefined;
            const caller = resolveCallerDomain(this.db, toolScope(a));
            const delivery = resolveDelivery(this.db, caller, sender, recipient);
            const id = this.db.insertMail(
              delivery.domain.id,
              delivery.sender,
              delivery.recipient,
              subject,
              body,
              replyTo,
            );
            publishMailSent(this.eventBus, {
              mailId: id,
              sender: delivery.sender,
              recipient: delivery.recipient,
              domainId: delivery.domain.id,
              domain: delivery.domain.name,
            });
            return { content: [{ type: "text" as const, text: JSON.stringify({ id }) }] };
          }

          case "_mail_read": {
            const recipient = a.recipient !== undefined ? String(a.recipient) : undefined;
            const unreadOnly = a.unreadOnly !== undefined ? Boolean(a.unreadOnly) : undefined;
            const limit = a.limit !== undefined ? Number(a.limit) : undefined;
            const caller = resolveCallerDomain(this.db, toolScope(a));
            const messages = this.db.readMail(caller.id, recipient, unreadOnly, limit);
            return { content: [{ type: "text" as const, text: JSON.stringify({ messages }) }] };
          }

          case "_mail_wait": {
            const recipient = a.recipient !== undefined ? String(a.recipient) : undefined;
            const timeoutSec = a.timeout !== undefined ? Number(a.timeout) : 30;
            const maxWait = Math.min(timeoutSec * 1000, 30_000);
            const deadline = Date.now() + maxWait;
            // Resolved before the loop: an unscoped wait must fail immediately, not block
            // for 30s and then report "no mail" — which reads as a healthy empty mailbox.
            const caller = resolveCallerDomain(this.db, toolScope(a));

            while (Date.now() < deadline) {
              if (this.stopped)
                return { content: [{ type: "text" as const, text: JSON.stringify({ message: null }) }] };
              const msg = this.db.getNextUnread(caller.id, recipient);
              if (msg) {
                this.db.markMailRead(msg.id, caller.id);
                return { content: [{ type: "text" as const, text: JSON.stringify({ message: msg }) }] };
              }
              await Bun.sleep(500);
            }
            return { content: [{ type: "text" as const, text: JSON.stringify({ message: null }) }] };
          }

          case "_mail_reply": {
            const id = Number(a.id);
            const sender = String(a.sender ?? "");
            const body = String(a.body ?? "");
            if (!sender || !body) {
              return { content: [{ type: "text" as const, text: "sender and body are required" }], isError: true };
            }
            const caller = resolveCallerDomain(this.db, toolScope(a));
            const original = this.db.getMailById(id, caller.id);
            if (!original) {
              return {
                content: [{ type: "text" as const, text: `Mail message ${id} not found` }],
                isError: true,
              };
            }
            const subject =
              a.subject !== undefined ? String(a.subject) : original.subject ? `Re: ${original.subject}` : undefined;
            const delivery = resolveDelivery(this.db, caller, sender, original.sender);
            const newId = this.db.insertMail(
              delivery.domain.id,
              delivery.sender,
              delivery.recipient,
              subject,
              body,
              id,
            );
            publishMailSent(this.eventBus, {
              mailId: newId,
              sender: delivery.sender,
              recipient: delivery.recipient,
              domainId: delivery.domain.id,
              domain: delivery.domain.name,
            });
            return { content: [{ type: "text" as const, text: JSON.stringify({ id: newId }) }] };
          }

          default:
            return {
              content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
              isError: true,
            };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      }
    });

    await this.server.connect(serverTransport);
    this.client = new Client({ name: `mcp-cli/${MAIL_SERVER_NAME}`, version: "0.1.0" });
    await this.client.connect(clientTransport);

    return { client: this.client, transport: this.clientTransport, tools: buildMailToolCache() };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      await this.client?.close();
    } catch {
      // ignore close errors
    }
    try {
      await this.server?.close();
    } catch {
      // ignore close errors
    }
    this.server = null;
    this.client = null;
    this.serverTransport = null;
    this.clientTransport = null;
  }
}

/** Pre-build tool cache for pool registration. */
export function buildMailToolCache(): Map<string, ToolInfo> {
  const cache = new Map<string, ToolInfo>();
  for (const t of TOOLS) {
    cache.set(t.name, {
      server: MAIL_SERVER_NAME,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    });
  }
  return cache;
}
