/**
 * Virtual MCP server that exposes work item tracking as MCP tools.
 *
 * Uses an in-process MCP Server with InMemoryTransport (no Workers).
 * Tools: track, untrack, list, get, update — mapping to WorkItemDb CRUD.
 */

import type { ToolInfo } from "@mcp-cli/core";
import { WORK_ITEMS_SERVER_NAME } from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { WorkItemDb, WorkItemPhase } from "./db/work-items";

const TOOLS = [
  {
    name: "work_items_track",
    description:
      "Create or update a tracked work item. Provide at least one of issueNumber, prNumber, or branch to identify the item.",
    inputSchema: {
      type: "object" as const,
      properties: {
        issueNumber: { type: "number", description: "GitHub issue number" },
        prNumber: { type: "number", description: "GitHub PR number" },
        branch: { type: "string", description: "Git branch name" },
        prUrl: { type: "string", description: "Full URL to the pull request" },
        phase: {
          type: "string",
          enum: ["impl", "review", "repair", "qa", "done"],
          description: "Pipeline phase (default: impl)",
        },
      },
    },
  },
  {
    name: "work_items_untrack",
    description: "Remove a tracked work item by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Work item ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "work_items_list",
    description: "List all tracked work items. Optionally filter by phase.",
    inputSchema: {
      type: "object" as const,
      properties: {
        phase: {
          type: "string",
          enum: ["impl", "review", "repair", "qa", "done"],
          description: "Filter by pipeline phase",
        },
      },
    },
  },
  {
    name: "work_items_get",
    description: "Get a single work item by ID, PR number, or issue number.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Work item ID" },
        prNumber: { type: "number", description: "PR number to look up" },
        issueNumber: { type: "number", description: "Issue number to look up" },
      },
    },
  },
  {
    name: "work_items_update",
    description: "Manually update fields on a work item (for Phase 1, before GitHub poller exists).",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Work item ID" },
        phase: {
          type: "string",
          enum: ["impl", "review", "repair", "qa", "done"],
          description: "New pipeline phase",
        },
        prNumber: { type: "number", description: "PR number" },
        prState: { type: "string", enum: ["draft", "open", "merged", "closed"], description: "PR state" },
        prUrl: { type: "string", description: "PR URL" },
        ciStatus: {
          type: "string",
          enum: ["none", "pending", "running", "passed", "failed"],
          description: "CI status",
        },
        ciRunId: { type: "number", description: "CI run ID" },
        ciSummary: { type: "string", description: "CI summary text" },
        reviewStatus: {
          type: "string",
          enum: ["none", "pending", "approved", "changes_requested"],
          description: "Review status",
        },
        branch: { type: "string", description: "Branch name" },
        issueNumber: { type: "number", description: "Issue number" },
      },
      required: ["id"],
    },
  },
] as const;

export class WorkItemsServer {
  private server: Server | null = null;
  private client: Client | null = null;
  private serverTransport: Transport | null = null;
  private clientTransport: Transport | null = null;

  constructor(private workItemDb: WorkItemDb) {}

  async start(): Promise<{ client: Client; transport: Transport; tools: Map<string, ToolInfo> }> {
    if (this.server) {
      throw new Error("WorkItemsServer already started");
    }

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    this.serverTransport = serverTransport;
    this.clientTransport = clientTransport;

    this.server = new Server({ name: WORK_ITEMS_SERVER_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });

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
          case "work_items_track": {
            const issueNumber = a.issueNumber !== undefined ? Number(a.issueNumber) : undefined;
            const prNumber = a.prNumber !== undefined ? Number(a.prNumber) : undefined;
            const branch = a.branch !== undefined ? String(a.branch) : undefined;

            if (issueNumber === undefined && prNumber === undefined && branch === undefined) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "At least one of issueNumber, prNumber, or branch is required",
                  },
                ],
                isError: true,
              };
            }

            // Check for existing item by PR or issue number first
            let existing = prNumber ? this.workItemDb.getWorkItemByPr(prNumber) : null;
            if (!existing && issueNumber) {
              existing = this.workItemDb.getWorkItemByIssue(issueNumber);
            }

            if (existing) {
              // Update existing item
              const updated = this.workItemDb.updateWorkItem(existing.id, {
                ...(issueNumber !== undefined ? { issueNumber } : {}),
                ...(prNumber !== undefined ? { prNumber } : {}),
                ...(branch !== undefined ? { branch } : {}),
                ...(a.prUrl !== undefined ? { prUrl: String(a.prUrl) } : {}),
                ...(a.phase !== undefined ? { phase: String(a.phase) as WorkItemPhase } : {}),
              });
              return { content: [{ type: "text" as const, text: JSON.stringify(updated) }] };
            }

            // Derive an ID from identifiers
            const id = prNumber ? `pr:${prNumber}` : issueNumber ? `issue:${issueNumber}` : `branch:${branch}`;
            const item = this.workItemDb.createWorkItem({
              id,
              issueNumber: issueNumber ?? null,
              prNumber: prNumber ?? null,
              branch: branch ?? null,
              prUrl: a.prUrl !== undefined ? String(a.prUrl) : null,
              phase: (a.phase as WorkItemPhase | undefined) ?? "impl",
            });
            return { content: [{ type: "text" as const, text: JSON.stringify(item) }] };
          }

          case "work_items_untrack": {
            const id = String(a.id ?? "");
            if (!id) {
              return { content: [{ type: "text" as const, text: "id is required" }], isError: true };
            }
            this.workItemDb.deleteWorkItem(id);
            return { content: [{ type: "text" as const, text: JSON.stringify({ deleted: id }) }] };
          }

          case "work_items_list": {
            const phase = a.phase !== undefined ? String(a.phase) : undefined;
            const items = this.workItemDb.listWorkItems(phase ? { phase } : undefined);
            return { content: [{ type: "text" as const, text: JSON.stringify({ items, count: items.length }) }] };
          }

          case "work_items_get": {
            const id = a.id !== undefined ? String(a.id) : undefined;
            const prNumber = a.prNumber !== undefined ? Number(a.prNumber) : undefined;
            const issueNumber = a.issueNumber !== undefined ? Number(a.issueNumber) : undefined;

            if (id === undefined && prNumber === undefined && issueNumber === undefined) {
              return {
                content: [{ type: "text" as const, text: "At least one of id, prNumber, or issueNumber is required" }],
                isError: true,
              };
            }

            let item = id ? this.workItemDb.getWorkItem(id) : null;
            if (!item && prNumber) item = this.workItemDb.getWorkItemByPr(prNumber);
            if (!item && issueNumber) item = this.workItemDb.getWorkItemByIssue(issueNumber);

            if (!item) {
              return { content: [{ type: "text" as const, text: "Work item not found" }], isError: true };
            }
            return { content: [{ type: "text" as const, text: JSON.stringify(item) }] };
          }

          case "work_items_update": {
            const id = String(a.id ?? "");
            if (!id) {
              return { content: [{ type: "text" as const, text: "id is required" }], isError: true };
            }

            const patch: Record<string, unknown> = {};
            if (a.phase !== undefined) patch.phase = String(a.phase);
            if (a.prNumber !== undefined) patch.prNumber = Number(a.prNumber);
            if (a.prState !== undefined) patch.prState = String(a.prState);
            if (a.prUrl !== undefined) patch.prUrl = String(a.prUrl);
            if (a.ciStatus !== undefined) patch.ciStatus = String(a.ciStatus);
            if (a.ciRunId !== undefined) patch.ciRunId = Number(a.ciRunId);
            if (a.ciSummary !== undefined) patch.ciSummary = String(a.ciSummary);
            if (a.reviewStatus !== undefined) patch.reviewStatus = String(a.reviewStatus);
            if (a.branch !== undefined) patch.branch = String(a.branch);
            if (a.issueNumber !== undefined) patch.issueNumber = Number(a.issueNumber);

            const updated = this.workItemDb.updateWorkItem(id, patch);
            return { content: [{ type: "text" as const, text: JSON.stringify(updated) }] };
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
    this.client = new Client({ name: `mcp-cli/${WORK_ITEMS_SERVER_NAME}`, version: "0.1.0" });
    await this.client.connect(clientTransport);

    return { client: this.client, transport: this.clientTransport, tools: buildWorkItemsToolCache() };
  }

  async stop(): Promise<void> {
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
export function buildWorkItemsToolCache(): Map<string, ToolInfo> {
  const cache = new Map<string, ToolInfo>();
  for (const t of TOOLS) {
    cache.set(t.name, {
      server: WORK_ITEMS_SERVER_NAME,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    });
  }
  return cache;
}
