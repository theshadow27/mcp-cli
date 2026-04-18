/**
 * Virtual MCP server that exposes work item tracking as MCP tools.
 *
 * Uses an in-process MCP Server with InMemoryTransport (no Workers).
 * Tools: track, untrack, list, get, update — mapping to WorkItemDb CRUD.
 */

import type { Logger, Manifest, ToolInfo, WorkItem, WorkItemPhase } from "@mcp-cli/core";
import { WORK_ITEMS_SERVER_NAME, canTransition, consoleLogger } from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { WorkItemDb } from "./db/work-items";

/** Parse a value to integer, returning undefined if absent or NaN. */
function parseIntOrUndefined(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Expected integer, got: ${String(value)}`);
  return Math.trunc(n);
}

/** Parse a value to integer, throwing if NaN. */
function requireInt(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got: ${String(value)}`);
  return Math.trunc(n);
}

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
          description:
            "New pipeline phase. When a .mcx manifest exists, must be a declared phase; otherwise must be one of: impl, review, repair, qa, done.",
        },
        repoRoot: {
          type: "string",
          description: "Absolute path to repo root; used to locate a .mcx manifest for phase-name validation.",
        },
        force: {
          type: "boolean",
          description: "Bypass transition validation. The transition is still recorded with forced=true.",
        },
        forceReason: {
          type: "string",
          description: "Human-readable reason recorded in the transition log when force=true.",
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
  private workItemDb: WorkItemDb;

  /** Called after a work item is tracked/updated so the poller can run immediately. */
  private onTrack: (() => void) | null;

  /** Resolves a manifest for a given repo root, or returns null. Injected for testability. */
  private loadManifestFn: ((repoRoot: string) => Manifest | null) | null;

  /** Resolves a PR number to its head branch name. Injected for testability. */
  private resolveBranchFromPr: ((prNumber: number) => Promise<string | null>) | null;

  private logger: Logger;

  constructor(
    workItemDb: WorkItemDb,
    opts?: {
      onTrack?: () => void;
      loadManifest?: (repoRoot: string) => Manifest | null;
      resolveBranchFromPr?: (prNumber: number) => Promise<string | null>;
      logger?: Logger;
    },
  ) {
    this.workItemDb = workItemDb;
    this.onTrack = opts?.onTrack ?? null;
    this.loadManifestFn = opts?.loadManifest ?? null;
    this.resolveBranchFromPr = opts?.resolveBranchFromPr ?? null;
    this.logger = opts?.logger ?? consoleLogger;
  }

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
            const issueNumber = parseIntOrUndefined(a.issueNumber);
            const prNumber = parseIntOrUndefined(a.prNumber);
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

            // Look up existing item by PR, issue, or branch — first match wins
            let existing = prNumber ? this.workItemDb.getWorkItemByPr(prNumber) : null;
            if (!existing && issueNumber) {
              existing = this.workItemDb.getWorkItemByIssue(issueNumber);
            }
            if (!existing && branch) {
              existing = this.workItemDb.getWorkItemByBranch(branch);
            }

            // Derive an ID from identifiers (PR takes priority)
            const id =
              existing?.id ?? (prNumber ? `pr:${prNumber}` : issueNumber ? `issue:${issueNumber}` : `branch:${branch}`);

            // Atomic upsert — avoids TOCTOU race between concurrent track calls
            let item = this.workItemDb.upsertWorkItem({
              id,
              issueNumber: issueNumber ?? undefined,
              prNumber: prNumber ?? undefined,
              branch: branch ?? undefined,
              prUrl: a.prUrl !== undefined ? String(a.prUrl) : undefined,
              phase: (a.phase as WorkItemPhase | undefined) ?? (existing ? undefined : "impl"),
            });

            // Auto-populate branch when prNumber is known but branch isn't —
            // fires on the initial track call too, not just update (#1449).
            if (prNumber != null && item.branch == null) {
              const wrote = await this.maybeResolveAndSetBranch(id, prNumber);
              if (wrote) {
                const refreshed = this.workItemDb.getWorkItem(id);
                if (refreshed) item = refreshed;
              }
            }

            this.onTrack?.();
            return { content: [{ type: "text" as const, text: JSON.stringify(item) }] };
          }

          case "work_items_untrack": {
            const id = String(a.id ?? "");
            if (!id) {
              return { content: [{ type: "text" as const, text: "id is required" }], isError: true };
            }
            const deleted = this.workItemDb.deleteWorkItem(id);
            if (!deleted) {
              return { content: [{ type: "text" as const, text: `Work item not found: ${id}` }], isError: true };
            }
            return { content: [{ type: "text" as const, text: JSON.stringify({ deleted: id }) }] };
          }

          case "work_items_list": {
            const phase = a.phase !== undefined ? String(a.phase) : undefined;
            const items = this.workItemDb.listWorkItems(phase ? { phase } : undefined);
            return { content: [{ type: "text" as const, text: JSON.stringify({ items, count: items.length }) }] };
          }

          case "work_items_get": {
            const id = a.id !== undefined ? String(a.id) : undefined;
            const prNumber = parseIntOrUndefined(a.prNumber);
            const issueNumber = parseIntOrUndefined(a.issueNumber);

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

            const force = a.force === true;
            const forceReason = a.forceReason !== undefined ? String(a.forceReason) : undefined;
            const repoRoot = a.repoRoot !== undefined ? String(a.repoRoot) : undefined;

            // Validate phase if a new phase is being set
            if (a.phase !== undefined) {
              const existing = this.workItemDb.getWorkItem(id);
              if (!existing) {
                return { content: [{ type: "text" as const, text: `work item not found: ${id}` }], isError: true };
              }
              const newPhase = String(a.phase);

              // force=true bypasses BOTH manifest-declared-phase validation and the
              // hardcoded transition graph. The forced transition is still logged
              // (see recordTransition call from updateWorkItem) so the audit trail
              // captures the bypass. Callers that supply force without forceReason
              // produce an un-auditable bypass — that's a caller bug, not ours.
              if (!force) {
                // Manifest-aware phase-name validation (no-op if no manifest or no loader)
                const manifest = repoRoot && this.loadManifestFn ? this.loadManifestFn(repoRoot) : null;
                if (manifest) {
                  const declared = Object.keys(manifest.phases);
                  if (!declared.includes(newPhase)) {
                    return {
                      content: [
                        {
                          type: "text" as const,
                          text: `unknown phase "${newPhase}". declared phases: ${declared.join(", ")}. pass force=true with forceReason to bypass.`,
                        },
                      ],
                      isError: true,
                    };
                  }
                  // Manifest-driven mode: skip the hardcoded transition graph.
                } else if (existing.phase !== newPhase && !canTransition(existing.phase, newPhase as WorkItemPhase)) {
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text: `Invalid phase transition: ${existing.phase} → ${newPhase}. pass force=true with forceReason to bypass.`,
                      },
                    ],
                    isError: true,
                  };
                }
              }
            }

            const patch: Partial<WorkItem> = {};
            if (a.phase !== undefined) patch.phase = String(a.phase) as WorkItemPhase;
            if (a.prNumber !== undefined) patch.prNumber = requireInt(a.prNumber, "prNumber");
            if (a.prState !== undefined) patch.prState = String(a.prState) as WorkItem["prState"];
            if (a.prUrl !== undefined) patch.prUrl = String(a.prUrl);
            if (a.ciStatus !== undefined) patch.ciStatus = String(a.ciStatus) as WorkItem["ciStatus"];
            if (a.ciRunId !== undefined) patch.ciRunId = requireInt(a.ciRunId, "ciRunId");
            if (a.ciSummary !== undefined) patch.ciSummary = String(a.ciSummary);
            if (a.reviewStatus !== undefined) patch.reviewStatus = String(a.reviewStatus) as WorkItem["reviewStatus"];
            // Treat `null` the same as absent — otherwise String(null) persists the literal
            // string "null" as the branch (round-3 Copilot inline comment).
            if (a.branch != null) patch.branch = String(a.branch);
            if (a.issueNumber !== undefined) patch.issueNumber = requireInt(a.issueNumber, "issueNumber");

            let updated = this.workItemDb.updateWorkItem(id, patch, { forced: force, forceReason });

            // Auto-populate branch when prNumber is being set and the patch didn't
            // supply a branch. Runs AFTER the main update so the helper's atomic
            // `setBranchIfNull` sees the latest row state and skips if another
            // writer won the race. Best-effort: a resolver failure is logged but
            // does not fail the update. See #1424 for the DX rationale.
            const newPrNumber = patch.prNumber;
            if (newPrNumber != null && patch.branch === undefined) {
              const wrote = await this.maybeResolveAndSetBranch(id, newPrNumber);
              if (wrote) {
                const refreshed = this.workItemDb.getWorkItem(id);
                if (refreshed) updated = refreshed;
              }
            }

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

  /**
   * Best-effort branch auto-populate: resolves a branch for the given PR and
   * writes it to the row ONLY if branch is still NULL at commit time.
   *
   * The atomic `setBranchIfNull` (WHERE branch IS NULL) closes the TOCTOU
   * window across the async gh call — a concurrent writer that set an
   * explicit branch during the await wins because the UPDATE's WHERE
   * filter drops our row (#1424 review round 3).
   *
   * Returns true when the branch was written, false on any failure or skip.
   */
  private async maybeResolveAndSetBranch(id: string, prNumber: number): Promise<boolean> {
    if (!this.resolveBranchFromPr) return false;
    const existing = this.workItemDb.getWorkItem(id);
    if (!existing || existing.branch != null) return false;
    let resolved: string | null = null;
    try {
      resolved = await this.resolveBranchFromPr(prNumber);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[mcpd] Failed to resolve branch for PR #${prNumber}: ${msg}`);
      return false;
    }
    if (!resolved) return false;
    return this.workItemDb.setBranchIfNull(id, resolved);
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
