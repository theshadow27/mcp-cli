/**
 * Shared helper for safely extracting content from MCP callTool results.
 *
 * An MCP CallToolResult can carry `isError: true` with the error message
 * in its `content` array. Consumers that index `.content` without first
 * checking `isError` silently parse error payloads as valid data.
 */

export class ToolResultError extends Error {
  override name = "ToolResultError" as const;
}

/** Defensively extract string texts from an unknown MCP result shape. */
function extractTexts(result: unknown): string[] {
  const r = result as { content?: unknown };
  if (!Array.isArray(r?.content)) return [];
  const texts: string[] = [];
  for (const b of r.content) {
    if (b != null && typeof b === "object" && (b as Record<string, unknown>).type === "text") {
      const t = (b as Record<string, unknown>).text;
      if (typeof t === "string") texts.push(t);
    }
  }
  return texts;
}

/**
 * Check `isError`, then return all text content blocks joined by `\n`.
 * Throws {@link ToolResultError} on error responses.
 * Returns `""` when the result has no text content blocks.
 */
export function unwrapToolResult(result: unknown): string {
  const texts = extractTexts(result);
  if ((result as { isError?: boolean })?.isError) {
    throw new ToolResultError(texts.join("\n") || "Unknown MCP tool error");
  }
  return texts.join("\n");
}

/**
 * Like {@link unwrapToolResult} but parses the first text block as JSON.
 * Returns the parsed value typed as `T` (caller is responsible for the cast).
 * Throws {@link ToolResultError} on error responses, missing text, or invalid JSON.
 */
export function unwrapToolResultJson<T>(result: unknown): T {
  const texts = extractTexts(result);
  if ((result as { isError?: boolean })?.isError) {
    throw new ToolResultError(texts[0] || "Unknown MCP tool error");
  }
  if (texts.length === 0) {
    throw new ToolResultError("MCP tool result has no text content");
  }
  try {
    return JSON.parse(texts[0]) as T;
  } catch (e) {
    throw new ToolResultError(`Failed to parse MCP tool result as JSON: ${texts[0].slice(0, 200)}`, { cause: e });
  }
}
