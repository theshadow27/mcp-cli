import type { LiveSpan } from "@mcp-cli/core";

export interface RequestContext {
  span: LiveSpan;
  /**
   * Aborts when the caller disconnects (including its own request timeout).
   * Handlers that may wait before producing a side effect must honor it —
   * a write performed after the caller gave up duplicates its retry.
   */
  signal?: AbortSignal;
}

export type RequestHandler = (params: unknown, ctx: RequestContext) => Promise<unknown>;
