import type { LiveSpan } from "@mcp-cli/core";

export interface RequestContext {
  span: LiveSpan;
}

export type RequestHandler = (params: unknown, ctx: RequestContext) => Promise<unknown>;
