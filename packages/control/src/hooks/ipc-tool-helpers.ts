/** Extract the first text content from an IPC callTool result. */
export function extractToolText(result: unknown): string | null {
  const r = result as { content?: Array<{ type: string; text: string }> } | undefined;
  return r?.content?.[0]?.text ?? null;
}
