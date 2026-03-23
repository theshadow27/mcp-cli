/**
 * Alias definition types for structured defineAlias() aliases.
 */

import type { z } from "zod/v4";
import { parsePythonRepr } from "./python-repr";

/** Options for the cache() helper in alias context */
export interface CacheOptions {
  /** Namespace prefix — defaults to the current alias name */
  prefix?: string;
  /** Time-to-live in ms — default 24h */
  ttl?: number;
}

/** Sentinel string to detect defineAlias scripts without executing them */
export const DEFINE_ALIAS_SENTINEL = "defineAlias(";

/** Check if source code uses defineAlias() (static text analysis, no execution) */
export function isDefineAlias(source: string): boolean {
  return source.includes(DEFINE_ALIAS_SENTINEL);
}

/** Proxy type for calling MCP tools: mcp.server.tool(args) */
export type McpProxy = Record<string, Record<string, (args?: Record<string, unknown>) => Promise<unknown>>>;

/** The context available inside a defineAlias handler function */
export interface AliasContext {
  /** Proxy for calling MCP tools: mcp.server.tool(args) */
  mcp: McpProxy;
  /** Raw CLI --key value pairs */
  args: Record<string, string>;
  /** Read a file as text */
  file: (path: string) => Promise<string>;
  /** Read and parse a JSON file */
  json: (path: string) => Promise<unknown>;
  /** Cache a value by key. Returns cached value if fresh, otherwise calls producer. */
  cache: <T>(key: string, producer: () => T | Promise<T>, opts?: CacheOptions) => Promise<T>;
}

/**
 * Structured alias definition with typed input/output via Zod schemas.
 *
 * At the defineAlias call site, TypeScript infers I and O from the schemas:
 *   defineAlias(({ z }) => ({
 *     input: z.object({ email: z.string() }), // I = { email: string }
 *     fn: (input) => input.email,              // input: { email: string }
 *   }))
 *
 * At the runner level, generics default to unknown for runtime operation.
 */
export interface AliasDefinition<I = unknown, O = unknown> {
  name: string;
  description?: string;
  input?: z.ZodType<I>;
  output?: z.ZodType<O>;
  fn: (input: I, ctx: AliasContext) => O | Promise<O>;
}

/** Alias type discriminant for DB and IPC */
export type AliasType = "freeform" | "defineAlias";

/**
 * Unwrap MCP tool call result content for ergonomic alias authoring.
 *
 * MCP results look like: { content: [{type: "text", text: "..."}] }
 * This extracts the actual value, attempting JSON parse on text content.
 */
export function extractContent(result: unknown): unknown {
  if (result && typeof result === "object" && "content" in result) {
    const { content } = result as { content: Array<{ type: string; text?: string }> };
    if (Array.isArray(content) && content.length === 1 && content[0].type === "text" && content[0].text) {
      const text = content[0].text;
      try {
        return JSON.parse(text);
      } catch {
        // JSON.parse failed — try Python repr conversion (e.g. Coralogix MCP responses)
        const parsed = parsePythonRepr(text);
        if (parsed !== text) return parsed;
        return text;
      }
    }
    // Multiple content items — return array of text
    return content.filter((c) => c.type === "text").map((c) => c.text);
  }
  return result;
}
