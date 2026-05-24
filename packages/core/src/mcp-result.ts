/**
 * Shared helper for safely extracting content from MCP callTool results.
 *
 * An MCP CallToolResult can carry `isError: true` with the error message
 * in its `content` array. Consumers that index `.content` without first
 * checking `isError` silently parse error payloads as valid data.
 */

/** Minimal shape of an MCP tool result — avoids coupling core to the SDK. */
interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export class ToolResultError extends Error {
  override name = "ToolResultError" as const;
}

/**
 * Check `isError`, then return all text content blocks joined by `\n`.
 * Throws {@link ToolResultError} if the result is an error response.
 */
export function unwrapToolResult(result: unknown): string {
  const r = result as McpToolResult;
  const texts = r?.content?.filter((b) => b.type === "text").map((b) => b.text) ?? [];
  if (r?.isError) {
    throw new ToolResultError(texts.join("\n") || "Unknown MCP tool error");
  }
  if (texts.length === 0) {
    throw new ToolResultError("MCP tool result has no text content");
  }
  return texts.join("\n");
}

/**
 * Like {@link unwrapToolResult} but parses the first text block as JSON.
 * Returns the parsed value typed as `T` (caller is responsible for the cast).
 * Uses the first text block only — joining multiple blocks would break JSON parsing.
 */
export function unwrapToolResultJson<T>(result: unknown): T {
  const r = result as McpToolResult;
  if (r?.isError) {
    const text = r.content?.[0]?.text ?? "Unknown MCP tool error";
    throw new ToolResultError(text);
  }
  const block = r?.content?.find((b) => b.type === "text");
  if (!block) {
    throw new ToolResultError("MCP tool result has no text content");
  }
  try {
    return JSON.parse(block.text) as T;
  } catch (e) {
    throw new ToolResultError(`Failed to parse MCP tool result as JSON: ${block.text.slice(0, 200)}`, { cause: e });
  }
}
