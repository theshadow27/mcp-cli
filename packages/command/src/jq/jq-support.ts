/**
 * Server-side jq support for proxied MCP tools.
 *
 * Injects an optional `jq` parameter into tool schemas and applies
 * post-processing to tool results: jq filtering, size protection,
 * or raw passthrough.
 */

import { JqUnavailableError, analyzeStructure, applyJqFilter, generateAnalysis } from "./index";

// ============================================================================
// Configuration
// ============================================================================

/** Below this, pass response through unchanged */
export const SERVE_SIZE_OK = 8 * 1024; // 8KB

/** Above this, replace with structural analysis */
export const SERVE_SIZE_TRUNCATE = 15 * 1024; // 15KB

// ============================================================================
// Schema injection
// ============================================================================

/** The jq parameter definition injected into tool schemas */
const JQ_PARAM = {
  type: "string" as const,
  description: "JQ filter to apply server-side (e.g., '.entities[:5]'). Set to 'false' to bypass size protection.",
};

/**
 * Inject the optional `jq` parameter into a tool's JSON Schema.
 * Returns a new schema object (does not mutate the input).
 */
export function injectJqParam(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const properties = (inputSchema.properties as Record<string, unknown>) ?? {};
  return {
    ...inputSchema,
    properties: {
      ...properties,
      jq: JQ_PARAM,
    },
  };
}

/**
 * Strip the `jq` key from tool arguments, returning the filter value
 * and the cleaned arguments separately.
 */
export function extractJqArg(args: Record<string, unknown>): {
  jqFilter: string | undefined;
  cleanArgs: Record<string, unknown>;
} {
  const { jq, ...cleanArgs } = args;
  return {
    jqFilter: typeof jq === "string" ? jq : undefined,
    cleanArgs,
  };
}

// ============================================================================
// Result post-processing
// ============================================================================

interface ToolCallContent {
  type: string;
  text: string;
}

interface ToolCallResult {
  [key: string]: unknown;
  isError?: boolean;
  content: ToolCallContent[];
}

/**
 * Compute total text size of an MCP tool result.
 */
function resultTextSize(result: ToolCallResult): number {
  let total = 0;
  for (const item of result.content) {
    if (item.type === "text") {
      total += Buffer.byteLength(item.text, "utf-8");
    }
  }
  return total;
}

/**
 * Concatenate all text content from a tool result into a single string.
 */
function resultText(result: ToolCallResult): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * Try to parse the result text as JSON. Returns undefined if not valid JSON.
 */
function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Apply jq post-processing to a tool result.
 *
 * Behavior depends on the `jqFilter` value:
 * - `undefined`: size protection applies (analyze if >15KB, hint if >8KB, pass-through if <8KB)
 * - `"false"`: bypass all protection, return raw result
 * - any other string: apply as jq filter, return filtered result
 */
export async function processJqResult(result: ToolCallResult, jqFilter: string | undefined): Promise<ToolCallResult> {
  // Error results pass through unchanged
  if (result.isError) return result;

  // Explicit bypass
  if (jqFilter === "false") return result;

  // Explicit jq filter
  if (jqFilter !== undefined) {
    const text = resultText(result);
    const data = tryParseJson(text);
    if (data === undefined) {
      return {
        isError: true,
        content: [{ type: "text", text: "Cannot apply jq filter: response is not valid JSON" }],
      };
    }
    try {
      const filtered = await applyJqFilter(data, jqFilter);
      return {
        content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
      };
    } catch (err: unknown) {
      if (err instanceof JqUnavailableError) {
        return {
          isError: true,
          content: [{ type: "text", text: `jq unavailable: ${err.message}. Use jq='false' to bypass.` }],
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `jq filter error: ${msg}` }],
      };
    }
  }

  // Size protection (no jq filter specified)
  const sizeBytes = resultTextSize(result);

  if (sizeBytes <= SERVE_SIZE_OK) {
    // Small response — pass through unchanged
    return result;
  }

  const text = resultText(result);
  const data = tryParseJson(text);

  if (sizeBytes <= SERVE_SIZE_TRUNCATE) {
    // Medium response — pass through with hint appended
    if (data !== undefined) {
      const sizeKB = (sizeBytes / 1024).toFixed(1);
      return {
        ...result,
        content: [
          ...result.content,
          {
            type: "text",
            text: `\n[mcx] ${sizeKB}KB response. Use jq parameter to filter (e.g., jq='.items[:5]') or jq='false' for full output.`,
          },
        ],
      };
    }
    // Non-JSON medium response — pass through as-is
    return result;
  }

  // Large response — structural analysis
  if (data !== undefined) {
    const analysis = generateAnalysis(data, sizeBytes);
    // Replace CLI-specific hint with serve-specific one
    const serveAnalysis = analysis.replace(
      /Use --jq '<filter>' to filter, or --full for raw output\./,
      "Use jq parameter to filter (e.g., jq='.items[:5]') or jq='false' for full output.",
    );
    return {
      content: [{ type: "text", text: serveAnalysis }],
    };
  }

  // Large non-JSON response — truncate with message
  const sizeKB = (sizeBytes / 1024).toFixed(1);
  const preview = text.slice(0, 500);
  return {
    content: [
      {
        type: "text",
        text: `Response too large (${sizeKB}KB, non-JSON). Preview:\n\n${preview}\n\n[truncated] Use jq='false' for full output.`,
      },
    ],
  };
}
