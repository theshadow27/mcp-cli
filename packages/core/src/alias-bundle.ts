/**
 * Alias bundling and execution via Bun.build + AsyncFunction eval.
 *
 * Replaces the Worker + bun.plugin() virtual module approach with:
 * 1. Bun.build to bundle alias scripts (externalizing "mcp-cli")
 * 2. stripMcpCliImport to remove the external import from bundled output
 * 3. AsyncFunction eval with injected dependencies
 *
 * This eliminates segfaults caused by concurrent import() with cache-busting
 * from worker threads (#577).
 */

import { z } from "zod/v4";
import type { AliasContext, AliasDefinition, McpProxy } from "./alias";

/** Stub MCP proxy — returns undefined for any server.tool() call. */
export const stubProxy: McpProxy = new Proxy({} as McpProxy, {
  get() {
    return new Proxy(
      {},
      {
        get() {
          return () => Promise.resolve(undefined);
        },
      },
    );
  },
});

/** Metadata extracted from a defineAlias script at save-time. */
export interface AliasMetadata {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/** Result of bundling an alias source file. */
export interface BundleResult {
  js: string;
  sourceHash: string;
}

/**
 * Bundle an alias source file using Bun.build.
 * Externalizes "mcp-cli" so the import statement can be stripped and
 * dependencies injected at eval time.
 */
export async function bundleAlias(sourcePath: string): Promise<BundleResult> {
  const result = await Bun.build({
    entrypoints: [sourcePath],
    external: ["mcp-cli"],
    target: "bun",
  });

  if (!result.success) {
    const msgs = result.logs.map((l) => l.message ?? String(l)).join("\n");
    throw new Error(`Failed to bundle alias: ${msgs}`);
  }

  const js = await result.outputs[0].text();
  const sourceHash = await computeSourceHash(sourcePath);

  return { js, sourceHash };
}

/**
 * Compute a SHA-256 hash of the source file for cache invalidation.
 */
export async function computeSourceHash(sourcePath: string): Promise<string> {
  const content = await Bun.file(sourcePath).arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

/**
 * Strip the "mcp-cli" import/require from Bun.build output.
 *
 * Bun.build with external: ["mcp-cli"] produces either:
 * - ESM: import { defineAlias, z, ... } from "mcp-cli";
 * - CJS: var/const { ... } = require("mcp-cli");
 *
 * We remove these lines so the bundled code can be eval'd with
 * injected dependencies.
 */
export function stripMcpCliImport(bundledJs: string): string {
  // ESM: import { ... } from "mcp-cli";  or  import ... from "mcp-cli";
  const esmPattern = /^import\s+.*from\s+["']mcp-cli["'];?\s*$/gm;
  // CJS: var/const/let { ... } = require("mcp-cli");
  const cjsPattern = /^(?:var|const|let)\s+.*=\s*require\(["']mcp-cli["']\);?\s*$/gm;

  return bundledJs.replace(esmPattern, "").replace(cjsPattern, "");
}

/**
 * Extract metadata from bundled defineAlias JS without executing the handler.
 *
 * Evaluates the bundled code with a capture-only defineAlias function that
 * records the definition and extracts JSON Schemas from Zod types.
 */
export async function extractMetadata(bundledJs: string): Promise<AliasMetadata> {
  const stripped = stripMcpCliImport(bundledJs);

  let captured: AliasDefinition | null = null;

  const injected = {
    defineAlias: (defOrFactory: AliasDefinition | ((ctx: { mcp: McpProxy; z: typeof z }) => AliasDefinition)) => {
      if (typeof defOrFactory === "function") {
        captured = defOrFactory({ mcp: stubProxy, z });
      } else {
        captured = defOrFactory;
      }
    },
    z,
    mcp: stubProxy,
    args: {},
    file: () => Promise.resolve(""),
    json: () => Promise.resolve(null),
  };

  const code = `const { defineAlias, z, mcp, args, file, json } = __mcp__;\n${stripped}`;
  const fn = new AsyncFunction("__mcp__", code);
  await fn(injected);

  if (!captured) {
    throw new Error("Script did not call defineAlias()");
  }

  const def = captured as AliasDefinition;
  const meta: AliasMetadata = {
    name: def.name,
    description: def.description ?? "",
  };

  try {
    if (def.input) {
      meta.inputSchema = z.toJSONSchema(def.input) as Record<string, unknown>;
    }
  } catch {
    /* schema conversion failed — skip */
  }

  try {
    if (def.output) {
      meta.outputSchema = z.toJSONSchema(def.output) as Record<string, unknown>;
    }
  } catch {
    /* schema conversion failed — skip */
  }

  return meta;
}

/**
 * Execute bundled alias JS with injected context.
 *
 * For defineAlias scripts: captures the definition, validates input,
 * calls the handler, validates output.
 *
 * For freeform scripts: side effects execute during eval.
 */
export async function executeAliasBundled(
  bundledJs: string,
  input: unknown,
  ctx: AliasContext,
  isDefineAlias: boolean,
): Promise<unknown> {
  const stripped = stripMcpCliImport(bundledJs);

  let captured: AliasDefinition | null = null;

  const injected = {
    defineAlias: (defOrFactory: AliasDefinition | ((dctx: { mcp: McpProxy; z: typeof z }) => AliasDefinition)) => {
      if (typeof defOrFactory === "function") {
        captured = defOrFactory({ mcp: ctx.mcp, z });
      } else {
        captured = defOrFactory;
      }
    },
    z,
    mcp: ctx.mcp,
    args: ctx.args,
    file: ctx.file,
    json: ctx.json,
  };

  const code = `const { defineAlias, z, mcp, args, file, json } = __mcp__;\n${stripped}`;
  const fn = new AsyncFunction("__mcp__", code);
  await fn(injected);

  if (!isDefineAlias) {
    // Freeform: side effects already executed during eval
    return undefined;
  }

  if (!captured) {
    throw new Error("Script did not call defineAlias()");
  }

  const def = captured as AliasDefinition;

  // Validate input
  let parsedInput = input;
  if (def.input) {
    const result = def.input.safeParse(input);
    if (!result.success) {
      throw new Error(`Invalid input: ${result.error.message}`);
    }
    parsedInput = result.data;
  }

  const output = await def.fn(parsedInput, ctx);

  // Validate output
  if (def.output) {
    const result = def.output.safeParse(output);
    if (!result.success) {
      throw new Error(`Invalid output: ${result.error.message}`);
    }
    return result.data;
  }

  return output;
}

// AsyncFunction constructor (not directly accessible as a global)
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;
