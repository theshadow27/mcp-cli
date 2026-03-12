/**
 * Utility for closing MCP clients with a bounded timeout.
 *
 * Used by virtual server stop() and crash handler paths to prevent
 * client.close() from blocking shutdown indefinitely when a worker is wedged.
 */

export const CLOSE_TIMEOUT_MS = 5_000;

/**
 * Close an MCP client with a timeout.
 *
 * Resolves (never throws) regardless of whether close() resolved, rejected,
 * or timed out. Callers should terminate the worker unconditionally after
 * calling this.
 */
export async function closeClientWithTimeout(
  client: { close(): Promise<void> } | null | undefined,
  timeoutMs: number = CLOSE_TIMEOUT_MS,
): Promise<void> {
  if (!client) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("client.close() timeout")), timeoutMs);
      }),
    ]);
  } catch {
    // timeout or close error — caller terminates worker unconditionally
  } finally {
    clearTimeout(timer);
  }
}
