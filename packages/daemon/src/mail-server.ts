/**
 * Virtual MCP server that exposes daemon mail as MCP tools.
 *
 * Uses an in-process MCP Server with InMemoryTransport (no Workers).
 * Tools map 1:1 to the IPC mail handlers: sendMail, readMail, waitForMail, replyToMail.
 */

import type { ToolInfo } from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { StateDb } from "./db/state";

export const MAIL_SERVER_NAME = "_mail";

const TOOLS = [
  {
    name: "_mail_send",
    description: "Send a mail message to a recipient.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sender: { type: "string", description: "Sender identifier (e.g. session name or role)" },
        recipient: { type: "string", description: "Recipient identifier" },
        subject: { type: "string", description: "Optional subject line" },
        body: { type: "string", description: "Message body" },
        replyTo: { type: "number", description: "ID of message being replied to, if any" },
      },
      required: ["sender", "recipient"],
    },
  },
  {
    name: "_mail_read",
    description: "Read messages from a mailbox.",
    inputSchema: {
      type: "object" as const,
      properties: {
        recipient: { type: "string", description: "Filter by recipient (omit for all)" },
        unreadOnly: { type: "boolean", description: "Return only unread messages (default false)" },
        limit: { type: "number", description: "Max messages to return" },
      },
    },
  },
  {
    name: "_mail_wait",
    description: "Block until a message arrives for the given recipient, or timeout expires.",
    inputSchema: {
      type: "object" as const,
      properties: {
        recipient: { type: "string", description: "Recipient to wait for" },
        timeout: { type: "number", description: "Timeout in seconds (default 30, max 30)" },
      },
    },
  },
  {
    name: "_mail_reply",
    description: "Reply to an existing message.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "ID of the message to reply to" },
        sender: { type: "string", description: "Sender identifier for the reply" },
        body: { type: "string", description: "Reply body" },
        subject: { type: "string", description: "Optional subject override (defaults to Re: <original>)" },
      },
      required: ["id", "sender", "body"],
    },
  },
] as const;

export class MailServer {
  private server: Server | null = null;
  private client: Client | null = null;
  private serverTransport: Transport | null = null;
  private clientTransport: Transport | null = null;
  private stopped = false;

  constructor(private db: StateDb) {}

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
            const id = this.db.insertMail(sender, recipient, subject, body, replyTo);
            return { content: [{ type: "text" as const, text: JSON.stringify({ id }) }] };
          }

          case "_mail_read": {
            const recipient = a.recipient !== undefined ? String(a.recipient) : undefined;
            const unreadOnly = a.unreadOnly !== undefined ? Boolean(a.unreadOnly) : undefined;
            const limit = a.limit !== undefined ? Number(a.limit) : undefined;
            const messages = this.db.readMail(recipient, unreadOnly, limit);
            return { content: [{ type: "text" as const, text: JSON.stringify({ messages }) }] };
          }

          case "_mail_wait": {
            const recipient = a.recipient !== undefined ? String(a.recipient) : undefined;
            const timeoutSec = a.timeout !== undefined ? Number(a.timeout) : 30;
            const maxWait = Math.min(timeoutSec * 1000, 30_000);
            const deadline = Date.now() + maxWait;

            while (Date.now() < deadline) {
              if (this.stopped)
                return { content: [{ type: "text" as const, text: JSON.stringify({ message: null }) }] };
              const msg = this.db.getNextUnread(recipient);
              if (msg) {
                this.db.markMailRead(msg.id);
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
            const original = this.db.getMailById(id);
            if (!original) {
              return {
                content: [{ type: "text" as const, text: `Mail message ${id} not found` }],
                isError: true,
              };
            }
            const subject =
              a.subject !== undefined ? String(a.subject) : original.subject ? `Re: ${original.subject}` : undefined;
            const newId = this.db.insertMail(sender, original.sender, subject, body, id);
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
