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
 * Check `isError`, then return the first text content block's text.
 * Throws {@link ToolResultError} if the result is an error response.
 */
export function unwrapToolResult(result: unknown): string {
  const r = result as McpToolResult;
  if (r?.isError) {
    const text = r.content?.[0]?.text ?? "Unknown MCP tool error";
    throw new ToolResultError(text);
  }
  if (r?.content?.[0]?.type === "text") {
    return r.content[0].text;
  }
  throw new ToolResultError("MCP tool result has no text content");
}

/**
 * {@link unwrapToolResult} + `JSON.parse`. Returns the parsed value typed
 * as `T` (caller is responsible for the cast).
 */
export function unwrapToolResultJson<T>(result: unknown): T {
  const text = unwrapToolResult(result);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ToolResultError(`Failed to parse MCP tool result as JSON: ${text.slice(0, 200)}`);
  }
}
