/**
 * Alias runner — executes TypeScript alias scripts via Bun's virtual module system.
 *
 * Supports two modes:
 * - **Freeform**: script runs at top level via side effects (legacy)
 * - **defineAlias**: structured definition with typed input/output via Zod schemas
 *
 * The virtual "mcp-cli" module provides both APIs:
 * - Legacy: `mcp`, `args`, `file`, `json`
 * - Structured: `defineAlias`, `z`
 */

import { resolve } from "node:path";
import { type AliasContext, type AliasDefinition, type McpProxy, ipcCall, options } from "@mcp-cli/core";
import { plugin } from "bun";
import { z } from "zod/v4";

// Module-level capture slot for defineAlias definitions.
// Reset before each runAlias call. Safe because CLI is single-threaded.
//
// Note: TypeScript 5.9's CFA can't track mutations inside plugin callbacks,
// so we use getCaptured() below to break the CFA chain when reading.
let _captured: AliasDefinition | null = null;
function getCaptured(): AliasDefinition | null {
  return _captured;
}

export async function runAlias(aliasPath: string, cliArgs: Record<string, string>, jsonInput?: string): Promise<void> {
  _captured = null;
  const mcpProxy = createMcpProxy();

  // Register virtual module BEFORE importing the alias
  plugin({
    name: "mcp-cli-alias-sdk",
    setup(builder) {
      builder.module("mcp-cli", () => ({
        exports: {
          // -- defineAlias API --
          defineAlias: (defOrFactory: AliasDefinition | ((ctx: { mcp: McpProxy; z: typeof z }) => AliasDefinition)) => {
            if (typeof defOrFactory === "function") {
              _captured = defOrFactory({ mcp: mcpProxy, z });
            } else {
              _captured = defOrFactory;
            }
          },
          z,

          // -- Legacy freeform API (backward compat) --
          mcp: mcpProxy,
          args: cliArgs,
          file: (path: string) => Bun.file(path).text(),
          json: async (path: string) => JSON.parse(await Bun.file(path).text()),
        },
        loader: "object",
      }));
    },
  });

  // Defense-in-depth: verify the alias path is inside the aliases directory
  const resolved = resolve(aliasPath);
  if (!resolved.startsWith(`${options.ALIASES_DIR}/`)) {
    throw new Error(`Refusing to execute alias outside aliases directory: ${resolved}`);
  }

  // Execute the alias script (triggers defineAlias capture or freeform side effects)
  await import(aliasPath);

  // If defineAlias was called, run the structured handler
  const def = getCaptured();
  if (def) {
    const ctx: AliasContext = {
      mcp: mcpProxy,
      args: cliArgs,
      file: (path: string) => Bun.file(path).text(),
      json: async (path: string) => JSON.parse(await Bun.file(path).text()),
    };

    const input = parseAliasInput(def.input, jsonInput, cliArgs);
    const output = await def.fn(input, ctx);
    const formatted = formatAliasOutput(output);
    if (formatted !== undefined) {
      console.log(formatted);
    }
  }
  // else: freeform script already executed via side effects during import
}

/**
 * Parse input for a defineAlias handler.
 *
 * If a Zod schema is provided, parses `rawJson` (first positional arg) as JSON
 * and validates it through the schema. Falls back to CLI args if no JSON given.
 * If no schema, returns the raw JSON-parsed value or CLI args.
 */
export function parseAliasInput(
  schema: z.ZodType | undefined,
  rawJson: string | undefined,
  cliArgs: Record<string, string>,
): unknown {
  // Parse the JSON input if provided
  let parsed: unknown;
  if (rawJson !== undefined && rawJson !== "") {
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      // Not valid JSON — treat as plain string
      parsed = rawJson;
    }
  } else {
    // No JSON input — use CLI args as object
    parsed = Object.keys(cliArgs).length > 0 ? cliArgs : undefined;
  }

  // Validate through schema if available
  if (schema) {
    const result = schema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Input validation failed:\n${issues}`);
    }
    return result.data;
  }

  return parsed;
}

/**
 * Format alias output for stdout.
 * Strings print raw, objects print as JSON, undefined/null produce no output.
 */
export function formatAliasOutput(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined;
  if (typeof output === "string") return output;
  return JSON.stringify(output, null, 2);
}

function createMcpProxy(): McpProxy {
  return new Proxy({} as McpProxy, {
    get(_target, serverName: string) {
      return new Proxy({} as Record<string, (args?: Record<string, unknown>) => Promise<unknown>>, {
        get(_inner, toolName: string) {
          return async (toolArgs?: Record<string, unknown>) => {
            const result = await ipcCall("callTool", {
              server: serverName,
              tool: toolName,
              arguments: toolArgs ?? {},
            });
            return extractContent(result);
          };
        },
      });
    },
  });
}

export function extractContent(result: unknown): unknown {
  // MCP results: { content: [{type: "text", text: "..."}] }
  // Unwrap to actual content for ergonomic alias authoring
  if (result && typeof result === "object" && "content" in result) {
    const { content } = result as { content: Array<{ type: string; text?: string }> };
    if (Array.isArray(content) && content.length === 1 && content[0].type === "text" && content[0].text) {
      try {
        return JSON.parse(content[0].text);
      } catch {
        return content[0].text;
      }
    }
    // Multiple content items — return array of text
    return content.filter((c) => c.type === "text").map((c) => c.text);
  }
  return result;
}
