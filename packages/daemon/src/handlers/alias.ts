import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
  CheckAliasParamsSchema,
  DeleteAliasParamsSchema,
  GetAliasParamsSchema,
  RecordAliasRunParamsSchema,
  SaveAliasParamsSchema,
  TouchAliasParamsSchema,
  bundleAlias,
  isDefineAlias,
  isDefineMonitor,
  options,
  safeAliasPath,
  validateFreeformTsc,
} from "@mcp-cli/core";
import type { IpcMethod, Logger } from "@mcp-cli/core";
import type { AliasServer } from "../alias-server";
import type { StateDb } from "../db/state";
import type { RequestHandler } from "../handler-types";

export class AliasHandlers {
  constructor(
    private db: StateDb,
    private aliasServer: AliasServer | null,
    private logger: Logger,
    private onAliasChanged?: (name: string) => void,
  ) {}

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("listAliases", async (_params, _ctx) => {
      return this.db.listAliases();
    });

    handlers.set("getAlias", async (params, _ctx) => {
      const { name } = GetAliasParamsSchema.parse(params);
      const alias = this.db.getAlias(name);
      if (!alias) return null;
      try {
        const script = readFileSync(alias.filePath, "utf-8");
        return { ...alias, script };
      } catch {
        return { ...alias, script: "" };
      }
    });

    handlers.set("saveAlias", async (params, _ctx) => {
      const parsed = SaveAliasParamsSchema.parse(params);
      const { name, script, description, expiresAt } = parsed;
      // If the caller did not supply `scope`, preserve the existing row's scope.
      // An explicit `null` clears scope; an explicit string sets it.
      const scopeProvided =
        typeof params === "object" && params !== null && Object.prototype.hasOwnProperty.call(params, "scope");
      const filePath = safeAliasPath(name);
      mkdirSync(options.ALIASES_DIR, { recursive: true });
      const wasMonitor = this.db.getAlias(name)?.aliasType === "defineMonitor";

      // Guard: refuse to overwrite a permanent alias with an ephemeral one.
      // This check must happen BEFORE writeFileSync to protect the file on disk.
      if (expiresAt != null) {
        const existing = this.db.getAlias(name);
        if (existing && existing.expiresAt === null) {
          return { ok: false, reason: "permanent_alias_exists" };
        }
      }

      // When caller didn't supply scope, pass scopeProvided=false so the SQL
      // UPDATE branch preserves the existing row's scope atomically (no TOCTOU).
      const scope: string | null = scopeProvided ? (parsed.scope ?? null) : null;

      const isMonitor = isDefineMonitor(script);
      const isStructured = !isMonitor && isDefineAlias(script);

      let finalScript: string;
      if (isStructured || isMonitor) {
        // defineAlias and defineMonitor scripts get everything via the virtual module — no auto-import
        finalScript = script;
      } else {
        // Freeform: auto-prepend import if not present (existing behavior)
        const hasImport = /import\s.*from\s+["']mcp-cli["']/.test(script);
        finalScript = hasImport ? script : `import { mcp, args, file, json } from "mcp-cli";\n${script}`;
      }

      writeFileSync(filePath, finalScript, "utf-8");

      const aliasType = isMonitor ? "defineMonitor" : isStructured ? "defineAlias" : "freeform";
      const warnings: string[] = [];
      const validationErrors: string[] = [];

      // Bundle the alias and extract metadata
      try {
        const { js, sourceHash } = await bundleAlias(filePath);

        if (isStructured) {
          if (!this.aliasServer) throw new Error("Alias server not initialized");
          const validation = await this.aliasServer.validateInSubprocess(js);
          if (!validation.valid) {
            validationErrors.push(...validation.errors);
          }
          if (validation.warnings.length > 0) {
            warnings.push(...validation.warnings);
          }
          this.db.saveAlias(
            name,
            filePath,
            validation.description || description,
            aliasType,
            validation.inputSchema ? JSON.stringify(validation.inputSchema) : undefined,
            validation.outputSchema ? JSON.stringify(validation.outputSchema) : undefined,
            js,
            sourceHash,
            expiresAt,
            scope ?? null,
            scopeProvided,
            validation.monitorDefs ? JSON.stringify(validation.monitorDefs) : undefined,
          );
        } else {
          // Mixed scripts (defineAlias + defineMonitor in the same file) are not supported.
          // The file was classified as defineMonitor (isMonitor=true), so defineAlias content
          // would be silently ignored. Reject early with a clear validation error instead.
          if (isMonitor && isDefineAlias(finalScript)) {
            validationErrors.push(
              "Script contains both defineAlias() and defineMonitor(). Mixed scripts are not supported — use one pattern per file.",
            );
          }
          // Freeform: extract monitor definitions in subprocess if sentinel detected
          let monitorDefsJson: string | undefined;
          if (isDefineMonitor(finalScript) && this.aliasServer) {
            try {
              const monitorDefs = await this.aliasServer.extractMonitorsInSubprocess(js);
              if (monitorDefs.length > 0) monitorDefsJson = JSON.stringify(monitorDefs);
            } catch (err) {
              this.logger.warn(
                `[saveAlias] extractMonitorMetadata failed for "${name}": ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          this.db.saveAlias(
            name,
            filePath,
            description,
            aliasType,
            undefined,
            undefined,
            js,
            sourceHash,
            expiresAt,
            scope ?? null,
            scopeProvided,
            monitorDefsJson,
          );
        }
      } catch (err) {
        // Bundle/extraction failed — save without bundle
        validationErrors.push(`Bundle failed: ${err instanceof Error ? err.message : String(err)}`);
        this.db.saveAlias(
          name,
          filePath,
          description,
          aliasType,
          undefined,
          undefined,
          undefined,
          undefined,
          expiresAt,
          scope ?? null,
          scopeProvided,
          undefined,
          false,
        );
      }

      // Refresh virtual alias server so new tool is immediately visible
      await this.aliasServer?.refresh();
      if (isMonitor || wasMonitor) this.onAliasChanged?.(name);
      const result: { ok: true; filePath: string; warnings?: string[]; validationErrors?: string[] } = {
        ok: true,
        filePath,
      };
      if (warnings.length > 0) result.warnings = warnings;
      if (validationErrors.length > 0) result.validationErrors = validationErrors;
      return result;
    });

    handlers.set("deleteAlias", async (params, _ctx) => {
      const { name } = DeleteAliasParamsSchema.parse(params);
      const alias = this.db.getAlias(name);
      if (alias) {
        try {
          unlinkSync(alias.filePath);
        } catch {
          // file already gone, fine
        }
        this.db.deleteAlias(name);
      }
      // Refresh virtual alias server so deleted tool is removed
      await this.aliasServer?.refresh();
      if (alias?.aliasType === "defineMonitor") this.onAliasChanged?.(name);
      return { ok: true };
    });

    handlers.set("touchAlias", async (params, _ctx) => {
      const { name, expiresAt } = TouchAliasParamsSchema.parse(params);
      this.db.touchAliasExpiry(name, expiresAt);
      return { ok: true };
    });

    handlers.set("recordAliasRun", async (params, _ctx) => {
      const { name } = RecordAliasRunParamsSchema.parse(params);
      const runCount = this.db.recordAliasRun(name);
      return { ok: true, runCount };
    });

    handlers.set("checkAlias", async (params, _ctx) => {
      const { name } = CheckAliasParamsSchema.parse(params);
      const alias = this.db.getAlias(name);
      if (!alias) {
        return { valid: false, aliasType: "freeform", errors: [`Alias "${name}" not found`], warnings: [] };
      }

      if (alias.aliasType !== "defineAlias") {
        // Freeform aliases — try bundling to check for syntax errors
        try {
          await bundleAlias(alias.filePath);
        } catch (err) {
          return {
            valid: false,
            aliasType: "freeform",
            errors: [`Bundle failed: ${err instanceof Error ? err.message : String(err)}`],
            warnings: [],
          };
        }

        // Run tsc --noEmit for type-level diagnostics (warnings only)
        const tsc = await validateFreeformTsc(alias.filePath);
        return { valid: true, aliasType: "freeform", errors: [], warnings: tsc.warnings };
      }

      // defineAlias — full validation
      try {
        const { js } = await bundleAlias(alias.filePath);
        if (!this.aliasServer) throw new Error("Alias server not initialized");
        return await this.aliasServer.validateInSubprocess(js);
      } catch (err) {
        return {
          valid: false,
          aliasType: "defineAlias",
          errors: [`Validation failed: ${err instanceof Error ? err.message : String(err)}`],
          warnings: [],
        };
      }
    });
  }
}
