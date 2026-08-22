/**
 * Virtual MCP server that exposes work item tracking as MCP tools.
 *
 * Uses an in-process MCP Server with InMemoryTransport (no Workers).
 * Tools: track, untrack, list, get, update — mapping to WorkItemDb CRUD.
 *
 * **Domain scoping (#3037).** Every tool here operates on one domain: the one the caller is
 * standing in, resolved by the daemon from the caller's cwd and delivered in MCP `_meta`
 * (see `domain-scope.ts`). Three properties follow, and each is a test in this file's spec
 * rather than a promise in this comment:
 *
 * 1. **No tool argument names a domain.** Not in any `inputSchema`, so no model ever sees
 *    one; and `work_items_update` rejects unknown keys, so passing `domainId` anyway is an
 *    error rather than a hint.
 * 2. **A session cannot forge one.** `_meta` is a sibling of `arguments` in the MCP request
 *    and the IPC schema strips unknown keys, so nothing a session writes reaches it.
 * 3. **There is no widening argument.** The handle is `workItemDb.forDomain(scope.id)`;
 *    a tool cannot ask for a second domain's rows because it has no way to name one.
 */

import { isAbsolute, resolve } from "node:path";
import type { Logger, Manifest, ToolInfo, WorkItem, WorkItemPatch, WorkItemPhase } from "@mcp-cli/core";
import {
  WORK_ITEMS_SERVER_NAME,
  canTransition,
  consoleLogger,
  isReservedPhaseStateKey,
  isStandardPhase,
  resolveRealpath,
  workItemStateNamespace,
} from "@mcp-cli/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { DomainWorkItems, WorkItemDb } from "./db/work-items";
import { type DomainScope, domainScopeFromMeta } from "./domain-scope";

/**
 * Narrow interface for alias_state operations — avoids coupling to full StateDb.
 *
 * **Deliberately not domain-scoped yet.** `alias_state` carries a `domain_id` column, but
 * it has two writers: these `phase_state_*` tools and the phase runner's `aliasStateSet`
 * IPC path. Scoping one without the other would split the `workitem:<id>` namespace in
 * half — the runner writing at `domain_id = 0` while a tool read at `domain_id = 3` — and
 * silently break the sentinels that gate verdict freshness and round caps. Both move
 * together in the alias_state sub-issue of #3021, not here. Work-item *identity* is already
 * partitioned, so the namespace key is unambiguous in the meantime.
 */
export interface PhaseStateStore {
  getAliasState(repoRoot: string, namespace: string, key: string): unknown;
  setAliasState(repoRoot: string, namespace: string, key: string, value: unknown): void;
  deleteAliasState(repoRoot: string, namespace: string, key: string): boolean;
  listAliasState(repoRoot: string, namespace: string): Record<string, unknown>;
}

/** Derived from the work_items_update inputSchema — single source of truth. */
let _updateKnownKeys: ReadonlySet<string> | null = null;
function updateKnownKeys(): ReadonlySet<string> {
  if (!_updateKnownKeys) {
    const updateTool = TOOLS.find((t) => t.name === "work_items_update");
    if (!updateTool) throw new Error("work_items_update tool definition missing");
    _updateKnownKeys = new Set(Object.keys(updateTool.inputSchema.properties));
  }
  return _updateKnownKeys;
}

/** Parse a value to integer, returning undefined if absent or NaN. */
function parseIntOrUndefined(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Expected integer, got: ${String(value)}`);
  return Math.trunc(n);
}

/** An MCP error result, ready to return from a tool handler. */
type ToolError = { content: Array<{ type: "text"; text: string }>; isError: true };

function toolError(text: string): { error: ToolError } {
  return { error: { content: [{ type: "text" as const, text }], isError: true } };
}

/**
 * Validate the arguments common to every `phase_state_*` tool and resolve the work item to
 * the namespace its state actually lives in.
 *
 * **The load-bearing line is `item.id`, not `workItemId`.** The four `phase_state_*` handlers
 * each used to build `workitem:${workItemId}` from the *raw argument*, while the phase runner
 * builds its namespace from the **stored** id the daemon returned. Once ids became
 * domain-qualified those two spellings diverge — `mcx track 42` in domain 1 returns `d1:#42`,
 * so a caller passing `#42` and a caller passing `d1:#42` addressed **different rows**. Worse,
 * the existence check accepts both spellings (`workItemIdCandidates`), so both callers
 * succeeded and neither saw an error: a phase script would read state the tools never wrote.
 *
 * Resolving through the database and taking `item.id` collapses both spellings onto the one
 * namespace. This lives in a single function, rather than being repeated in four handlers,
 * because four copies of a normalization step is how three of them come to be missing it.
 */
function resolvePhaseStateTarget(
  stateDb: PhaseStateStore | null,
  scoped: DomainWorkItems,
  a: Record<string, unknown>,
  opts: { requireKey: boolean },
): { repoRoot: string; key: string; ns: string } | { error: ToolError } {
  if (!stateDb) return toolError("Phase state not available (no stateDb configured)");

  const workItemId = String(a.workItemId ?? "");
  const rawRepoRoot = String(a.repoRoot ?? "").trim();
  if (rawRepoRoot && !isAbsolute(rawRepoRoot)) return toolError("repoRoot must be an absolute path");

  const repoRoot = rawRepoRoot ? resolveRealpath(resolve(rawRepoRoot)) : "";
  const key = String(a.key ?? "");
  if (!workItemId || !repoRoot || (opts.requireKey && !key)) {
    return toolError(
      opts.requireKey ? "workItemId, repoRoot, and key are required" : "workItemId and repoRoot are required",
    );
  }

  const item = scoped.getWorkItem(workItemId);
  if (!item) return toolError(`Work item not found: ${workItemId}`);

  return { repoRoot, key, ns: workItemStateNamespace(item.id) };
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
    description:
      "List all tracked work items. Optionally filter by phase. Stale done items (phase=done, not updated in more than 7 days) are hidden by default; pass include_archived=false to suppress them explicitly, or omit/true to see everything.",
    inputSchema: {
      type: "object" as const,
      properties: {
        phase: {
          type: "string",
          enum: ["impl", "review", "repair", "qa", "done"],
          description: "Filter by pipeline phase",
        },
        include_archived: {
          type: "boolean",
          description:
            "When false, hide stale done items (phase=done, not updated in more than 7 days). Default: true (show all).",
        },
      },
    },
  },
  {
    name: "work_items_get",
    description:
      "Get a single work item by ID, PR number, or issue number. This is a queryable existence probe: a missing row is a normal answer, not an error. Returns a non-error, discriminable result — `{ found: true, item }` when present, `{ found: false, ...lookupKeys }` when absent — so callers (including `mcx call`, which exits 1 on isError) can branch on existence. isError is reserved for malformed calls (no lookup key supplied) and genuine internal failures.",
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
        prNumber: { type: ["number", "null"], description: "PR number; null clears the field" },
        prState: {
          anyOf: [{ type: "string", enum: ["draft", "open", "merged", "closed"] }, { type: "null" }],
          description: "PR state; null clears the field",
        },
        prUrl: { type: ["string", "null"], description: "PR URL; null clears the field" },
        ciStatus: {
          type: "string",
          enum: ["none", "pending", "running", "passed", "failed"],
          description: "CI status",
        },
        ciRunId: { type: ["number", "null"], description: "CI run ID; null clears the field" },
        ciSummary: { type: ["string", "null"], description: "CI summary text; null clears the field" },
        reviewStatus: {
          type: "string",
          enum: ["none", "pending", "approved", "changes_requested"],
          description: "Review status",
        },
        branch: { type: ["string", "null"], description: "Branch name; null clears the field" },
        issueNumber: { type: ["number", "null"], description: "Issue number; null clears the field" },
      },
      required: ["id"],
    },
  },
  {
    name: "phase_state_get",
    description: "Read a single key from a work item's phase-scoped key-value store.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workItemId: { type: "string", description: "Work item ID" },
        repoRoot: { type: "string", description: "Absolute path to repo root" },
        key: { type: "string", description: "State key to read" },
      },
      required: ["workItemId", "repoRoot", "key"],
    },
  },
  {
    name: "phase_state_set",
    description:
      "Write a key to a work item's phase-scoped key-value store. Value must be JSON-serialisable and under 256 KB. Reserved phase-runner sentinels (keys ending in _spawned_at or _round, and previous_phase) are rejected — they gate verdict freshness and round caps and are written only by the phase runner.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workItemId: { type: "string", description: "Work item ID" },
        repoRoot: { type: "string", description: "Absolute path to repo root" },
        key: { type: "string", description: "State key to write" },
        value: {
          type: ["string", "number", "boolean", "object", "array", "null"] as const,
          description: "JSON-serialisable value to store (max 256 KB). Use phase_state_delete to remove.",
        },
      },
      required: ["workItemId", "repoRoot", "key", "value"],
    },
  },
  {
    name: "phase_state_delete",
    description: "Delete a key from a work item's phase-scoped key-value store.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workItemId: { type: "string", description: "Work item ID" },
        repoRoot: { type: "string", description: "Absolute path to repo root" },
        key: { type: "string", description: "State key to delete" },
      },
      required: ["workItemId", "repoRoot", "key"],
    },
  },
  {
    name: "phase_state_list",
    description: "List all key-value pairs in a work item's phase-scoped key-value store.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workItemId: { type: "string", description: "Work item ID" },
        repoRoot: { type: "string", description: "Absolute path to repo root" },
      },
      required: ["workItemId", "repoRoot"],
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

  /** Optional store for phase-scoped state (alias_state table). */
  private stateDb: PhaseStateStore | null;

  private logger: Logger;

  constructor(
    workItemDb: WorkItemDb,
    opts?: {
      onTrack?: () => void;
      loadManifest?: (repoRoot: string) => Manifest | null;
      resolveBranchFromPr?: (prNumber: number) => Promise<string | null>;
      stateDb?: PhaseStateStore;
      logger?: Logger;
    },
  ) {
    this.workItemDb = workItemDb;
    this.onTrack = opts?.onTrack ?? null;
    this.loadManifestFn = opts?.loadManifest ?? null;
    this.resolveBranchFromPr = opts?.resolveBranchFromPr ?? null;
    this.stateDb = opts?.stateDb ?? null;
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

      // The caller's domain, decided by the daemon before this request was built. Read from
      // `_meta`, never from `args` — see the file header. An absent or malformed value is
      // the unassigned partition, which is where every pre-domain row already lives.
      const scope = domainScopeFromMeta(request.params._meta);
      const scoped = this.workItemDb.forDomain(scope.id);

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
            let existing = prNumber ? scoped.getWorkItemByPr(prNumber) : null;
            if (!existing && issueNumber) {
              existing = scoped.getWorkItemByIssue(issueNumber);
            }
            if (!existing && branch) {
              existing = scoped.getWorkItemByBranch(branch);
            }

            // Derive an ID from identifiers (PR takes priority)
            const id =
              existing?.id ?? (prNumber ? `pr:${prNumber}` : issueNumber ? `issue:${issueNumber}` : `branch:${branch}`);

            // Atomic upsert — avoids TOCTOU race between concurrent track calls
            let item = scoped.upsertWorkItem({
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
              const wrote = await this.maybeResolveAndSetBranch(scoped, item.id, prNumber);
              if (wrote) {
                const refreshed = scoped.getWorkItem(id);
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
            const deleted = scoped.deleteWorkItem(id);
            if (!deleted) {
              return { content: [{ type: "text" as const, text: `Work item not found: ${id}` }], isError: true };
            }
            return { content: [{ type: "text" as const, text: JSON.stringify({ deleted: id }) }] };
          }

          case "work_items_list": {
            const phase = a.phase !== undefined ? String(a.phase) : undefined;
            // Only filter when caller explicitly opts out of archived items (include_archived === false).
            const excludeArchived = a.include_archived === false;
            const items = scoped.listWorkItems({ ...(phase ? { phase } : {}), excludeArchived });
            const hiddenCount = excludeArchived ? scoped.countArchivedWorkItems() : 0;
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ items, count: items.length, hiddenCount }) }],
            };
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

            let item = id ? scoped.getWorkItem(id) : null;
            if (!item && prNumber) item = scoped.getWorkItemByPr(prNumber);
            if (!item && issueNumber) item = scoped.getWorkItemByIssue(issueNumber);

            // Absence is a queryable answer, not a failure (#2834): return a
            // non-error discriminable payload so `mcx call` (which exits 1 on
            // isError, #2821) can be used as an existence probe.
            if (!item) {
              const notFound: { found: false; id?: string; prNumber?: number; issueNumber?: number } = { found: false };
              if (id !== undefined) notFound.id = id;
              if (prNumber !== undefined) notFound.prNumber = prNumber;
              if (issueNumber !== undefined) notFound.issueNumber = issueNumber;
              return { content: [{ type: "text" as const, text: JSON.stringify(notFound) }] };
            }
            return { content: [{ type: "text" as const, text: JSON.stringify({ found: true, item }) }] };
          }

          case "work_items_update": {
            const id = String(a.id ?? "");
            if (!id) {
              return { content: [{ type: "text" as const, text: "id is required" }], isError: true };
            }

            const known = updateKnownKeys();
            const unknownKeys = Object.keys(a)
              .filter((k) => !known.has(k))
              .sort();
            if (unknownKeys.length > 0) {
              const accepted = [...known]
                .filter((k) => k !== "id")
                .sort()
                .join(", ");
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Unknown keys: ${unknownKeys.join(", ")}. work_items_update only accepts known keys (${accepted}). Phase-namespace state (session_id, qa_session_id, etc.) is stored separately — use phase_state_get/set/delete/list tools to read/write it.`,
                  },
                ],
                isError: true,
              };
            }

            const force = a.force === true;
            const forceReason = a.forceReason !== undefined ? String(a.forceReason) : undefined;
            // Canonicalize to remove trailing slashes and resolve symlinks (#1526) — validate non-empty before resolve to avoid cwd fallback
            const rawRepoRootUpdate = a.repoRoot !== undefined ? String(a.repoRoot).trim() : undefined;
            const repoRoot = rawRepoRootUpdate ? resolveRealpath(resolve(rawRepoRootUpdate)) : undefined;

            // Validate phase if a new phase is being set
            if (a.phase !== undefined) {
              const existing = scoped.getWorkItem(id);
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
                } else if (
                  isStandardPhase(existing.phase) &&
                  existing.phase !== newPhase &&
                  !canTransition(existing.phase, newPhase as WorkItemPhase)
                ) {
                  // Fallback path: no manifest was loaded (repoRoot omitted or load
                  // failed), so the hardcoded VALID_TRANSITIONS graph is enforced.
                  // This graph cannot represent manifest-only phases (e.g.
                  // "needs-attention"), so a transition legal per .mcx.yaml can be
                  // rejected here. Warn so the divergence is not silent (#2781).
                  const reason = repoRoot
                    ? `manifest could not be loaded from ${repoRoot}`
                    : "no repoRoot was supplied";
                  this.logger.warn(
                    `[mcpd] work_items_update ${id}: validating ${existing.phase} → ${newPhase} against the hardcoded transition graph because ${reason}; .mcx.yaml phase edges were NOT consulted.`,
                  );
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text: `Invalid phase transition: ${existing.phase} → ${newPhase} (hardcoded graph; ${reason}, so .mcx.yaml edges were not consulted). Supply repoRoot to validate against the manifest, or pass force=true with forceReason to bypass.`,
                      },
                    ],
                    isError: true,
                  };
                }
              }
            }

            const patch: WorkItemPatch = {};
            if (a.phase !== undefined) patch.phase = String(a.phase) as WorkItemPhase;
            // For nullable fields: explicit null clears the field (stores SQL NULL).
            // undefined means "not provided — leave unchanged".
            if (a.prNumber !== undefined)
              patch.prNumber = a.prNumber === null ? null : requireInt(a.prNumber, "prNumber");
            if (a.prState !== undefined)
              patch.prState = a.prState === null ? null : (String(a.prState) as WorkItem["prState"]);
            if (a.prUrl !== undefined) patch.prUrl = a.prUrl === null ? null : String(a.prUrl);
            // ciStatus and reviewStatus are non-nullable (default "none"); skip null.
            if (a.ciStatus != null) patch.ciStatus = String(a.ciStatus) as WorkItem["ciStatus"];
            if (a.ciRunId !== undefined) patch.ciRunId = a.ciRunId === null ? null : requireInt(a.ciRunId, "ciRunId");
            if (a.ciSummary !== undefined) patch.ciSummary = a.ciSummary === null ? null : String(a.ciSummary);
            if (a.reviewStatus != null) patch.reviewStatus = String(a.reviewStatus) as WorkItem["reviewStatus"];
            if (a.branch !== undefined) patch.branch = a.branch === null ? null : String(a.branch);
            if (a.issueNumber !== undefined)
              patch.issueNumber = a.issueNumber === null ? null : requireInt(a.issueNumber, "issueNumber");

            let updated = scoped.updateWorkItem(id, patch, { forced: force, forceReason });

            // Auto-populate branch when prNumber is being set and the patch didn't
            // supply a branch. Runs AFTER the main update so the helper's atomic
            // `setBranchIfNull` sees the latest row state and skips if another
            // writer won the race. Best-effort: a resolver failure is logged but
            // does not fail the update. See #1424 for the DX rationale.
            const newPrNumber = patch.prNumber;
            if (newPrNumber != null && patch.branch === undefined) {
              const wrote = await this.maybeResolveAndSetBranch(scoped, updated.id, newPrNumber);
              if (wrote) {
                const refreshed = scoped.getWorkItem(id);
                if (refreshed) updated = refreshed;
              }
            }

            return { content: [{ type: "text" as const, text: JSON.stringify(updated) }] };
          }

          case "phase_state_get": {
            const target = resolvePhaseStateTarget(this.stateDb, scoped, a, { requireKey: true });
            if ("error" in target) return target.error;
            const value = this.stateDb?.getAliasState(target.repoRoot, target.ns, target.key);
            return { content: [{ type: "text" as const, text: JSON.stringify({ key: target.key, value }) }] };
          }

          case "phase_state_set": {
            if (a.value === undefined) {
              return {
                content: [{ type: "text" as const, text: "value is required; use phase_state_delete to remove a key" }],
                isError: true,
              };
            }
            const target = resolvePhaseStateTarget(this.stateDb, scoped, a, { requireKey: true });
            if ("error" in target) return target.error;
            const { repoRoot, key, ns } = target;
            if (isReservedPhaseStateKey(key)) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Refusing to write reserved phase-runner sentinel "${key}". Keys ending in _spawned_at or _round, and previous_phase, are written exclusively by the phase runner (they gate verdict freshness and round caps). This tool is for orchestrator bookkeeping (e.g. the *_session_id family).`,
                  },
                ],
                isError: true,
              };
            }
            this.stateDb?.setAliasState(repoRoot, ns, key, a.value);
            return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, key }) }] };
          }

          case "phase_state_delete": {
            const target = resolvePhaseStateTarget(this.stateDb, scoped, a, { requireKey: true });
            if ("error" in target) return target.error;
            const { repoRoot, key, ns } = target;
            if (isReservedPhaseStateKey(key)) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Refusing to delete reserved phase-runner sentinel "${key}". Keys ending in _spawned_at or _round, and previous_phase, are managed exclusively by the phase runner (they gate verdict freshness and round caps).`,
                  },
                ],
                isError: true,
              };
            }
            const deleted = this.stateDb?.deleteAliasState(repoRoot, ns, key) ?? false;
            return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, key, deleted }) }] };
          }

          case "phase_state_list": {
            const target = resolvePhaseStateTarget(this.stateDb, scoped, a, { requireKey: false });
            if ("error" in target) return target.error;
            const entries = this.stateDb?.listAliasState(target.repoRoot, target.ns) ?? {};
            return {
              content: [
                { type: "text" as const, text: JSON.stringify({ entries, count: Object.keys(entries).length }) },
              ],
            };
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
  private async maybeResolveAndSetBranch(scoped: DomainWorkItems, id: string, prNumber: number): Promise<boolean> {
    if (!this.resolveBranchFromPr) return false;
    const existing = scoped.getWorkItem(id);
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
    return scoped.setBranchIfNull(id, resolved);
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
