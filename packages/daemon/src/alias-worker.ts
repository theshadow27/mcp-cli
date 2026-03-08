/**
 * Bun Worker for extracting defineAlias metadata from alias scripts.
 *
 * Runs in an isolated worker thread to safely eval alias code without
 * affecting the daemon process. Captures the definition and extracts
 * JSON Schemas from Zod types.
 *
 * Protocol:
 *   Parent posts: { aliasPath: string }
 *   Worker posts: { name, description, inputSchema?, outputSchema? } | { error: string }
 */

import type { AliasDefinition } from "@mcp-cli/core";
import { z } from "zod/v4";
import { registerMcpPlugin } from "./worker-plugin";

// Module-level capture slot. See alias-runner.ts for CFA note.
let _captured: AliasDefinition | null = null;
function getCaptured(): AliasDefinition | null {
  return _captured;
}

// Register virtual module with defineAlias capture
registerMcpPlugin({
  name: "mcp-cli-alias-worker",
  onDefine: (def) => {
    _captured = def;
  },
  file: () => Promise.resolve(""),
  json: () => Promise.resolve(null),
});

declare const self: Worker;

self.onmessage = async (event: MessageEvent<{ aliasPath: string }>) => {
  try {
    const { aliasPath } = event.data;
    _captured = null;

    await import(aliasPath);

    const def = getCaptured();
    if (!def) {
      self.postMessage({ error: "no-define-alias" });
      return;
    }

    let inputSchema: Record<string, unknown> | undefined;
    let outputSchema: Record<string, unknown> | undefined;

    try {
      if (def.input) {
        inputSchema = z.toJSONSchema(def.input) as Record<string, unknown>;
      }
    } catch {
      /* schema conversion failed — skip */
    }

    try {
      if (def.output) {
        outputSchema = z.toJSONSchema(def.output) as Record<string, unknown>;
      }
    } catch {
      /* schema conversion failed — skip */
    }

    self.postMessage({
      name: def.name,
      description: def.description ?? "",
      inputSchema,
      outputSchema,
    });
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
