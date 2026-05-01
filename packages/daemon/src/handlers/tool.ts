import {
  ALIAS_SERVER_NAME,
  CallToolParamsSchema,
  GetToolInfoParamsSchema,
  GrepToolsParamsSchema,
  ListToolsParamsSchema,
  RestartServerParamsSchema,
} from "@mcp-cli/core";
import type { IpcMethod, Logger } from "@mcp-cli/core";
import type { AliasServer } from "../alias-server";
import type { StateDb } from "../db/state";
import type { RequestHandler } from "../handler-types";
import { metrics } from "../metrics";
import type { ServerPool } from "../server-pool";

export class ToolHandlers {
  constructor(
    private pool: ServerPool,
    private db: StateDb,
    private aliasServer: AliasServer | null,
    private daemonId: string,
    private logger: Logger,
  ) {}

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("listTools", async (params, _ctx) => {
      const { server } = ListToolsParamsSchema.parse(params ?? {});
      return this.pool.listTools(server);
    });

    handlers.set("getToolInfo", async (params, _ctx) => {
      const { server, tool } = GetToolInfoParamsSchema.parse(params);
      const info = await this.pool.getToolInfo(server, tool);
      const note = this.db.getNote(server, tool);
      return note ? { ...info, note } : info;
    });

    handlers.set("grepTools", async (params, _ctx) => {
      const { pattern } = GrepToolsParamsSchema.parse(params);
      const tools = await this.pool.grepTools(pattern);

      // Enrich matched tools with notes and check if any notes match the pattern
      const allNotes = this.db.listNotes();
      const noteMap = new Map(allNotes.map((n) => [`${n.serverName}\0${n.toolName}`, n.note]));

      // Add notes to already-matched tools
      const enriched = tools.map((t) => {
        const note = noteMap.get(`${t.server}\0${t.name}`);
        return note ? { ...t, note } : t;
      });

      // Find tools that match via note content but weren't already matched
      const matchedKeys = new Set(tools.map((t) => `${t.server}\0${t.name}`));
      const regex = new RegExp(
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, "."),
        "i",
      );
      const noteMatches = allNotes.filter(
        (n) => !matchedKeys.has(`${n.serverName}\0${n.toolName}`) && regex.test(n.note),
      );

      // For note-matched tools, fetch their full ToolInfo
      for (const n of noteMatches) {
        try {
          const info = await this.pool.getToolInfo(n.serverName, n.toolName);
          enriched.push({ ...info, note: n.note });
        } catch {
          // Tool no longer exists — skip
        }
      }

      return enriched;
    });

    handlers.set("callTool", async (params, ctx) => {
      const { server, tool, arguments: args, timeoutMs, callChain, cwd } = CallToolParamsSchema.parse(params);
      const toolSpan = ctx.span.child(`tool.${server}.${tool}`);
      toolSpan.setAttribute("tool.server", server);
      toolSpan.setAttribute("tool.name", tool);
      if (callChain) toolSpan.setAttribute("alias.callChainDepth", callChain.length);
      const toolLabels = { server, tool };
      try {
        // Route every _aliases call through the alias server directly so the
        // caller's cwd (for repo-root scoping) and optional callChain reach
        // the executor subprocess. The pool route has no cwd channel.
        const result =
          server === ALIAS_SERVER_NAME && this.aliasServer
            ? await this.aliasServer.callToolWithChain(tool, args, callChain ?? [], cwd, timeoutMs)
            : await this.pool.callTool(server, tool, args, timeoutMs);
        toolSpan.setStatus("OK");
        const finished = toolSpan.end();
        // Dual-write: usage_stats (Phase 1 compat) + spans table
        this.db.recordUsage(server, tool, finished.durationMs, true, undefined, {
          daemonId: this.daemonId,
          traceId: finished.traceId,
          parentId: finished.parentSpanId,
        });
        this.db.recordSpan(finished, this.daemonId);
        metrics.counter("mcpd_tool_calls_total", toolLabels).inc();
        metrics.histogram("mcpd_tool_call_duration_ms", toolLabels).observe(finished.durationMs);
        return result;
      } catch (err) {
        toolSpan.setStatus("ERROR");
        toolSpan.setAttribute("error.message", err instanceof Error ? err.message : String(err));
        const finished = toolSpan.end();
        this.db.recordUsage(
          server,
          tool,
          finished.durationMs,
          false,
          err instanceof Error ? err.message : String(err),
          { daemonId: this.daemonId, traceId: finished.traceId, parentId: finished.parentSpanId },
        );
        this.db.recordSpan(finished, this.daemonId);
        metrics.counter("mcpd_tool_calls_total", toolLabels).inc();
        metrics.counter("mcpd_tool_errors_total", toolLabels).inc();
        metrics.histogram("mcpd_tool_call_duration_ms", toolLabels).observe(finished.durationMs);
        throw err;
      }
    });

    handlers.set("restartServer", async (params, _ctx) => {
      const { server } = RestartServerParamsSchema.parse(params ?? {});
      await this.pool.restart(server);
      return { ok: true };
    });
  }
}
