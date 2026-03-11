/**
 * Alias executor subprocess script.
 *
 * Launched by Bun.spawn from the daemon's alias server to execute
 * alias scripts in an isolated subprocess. Reads bundled JS + input
 * from stdin as JSON, executes via AsyncFunction eval, writes result
 * to stdout as JSON.
 *
 * This provides fault isolation: sync infinite loops, prototype
 * pollution, or crashes kill this subprocess, not the daemon.
 */

import { readFile } from "node:fs/promises";
import type { AliasContext, AliasDefinition, McpProxy } from "@mcp-cli/core";
import { z } from "zod/v4";

// AsyncFunction constructor
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

/** Stub MCP proxy — returns undefined for any server.tool() call. */
const stubProxy: McpProxy = new Proxy({} as McpProxy, {
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

interface ExecutorInput {
  bundledJs: string;
  input: unknown;
  isDefineAlias: boolean;
}

async function main(): Promise<void> {
  // Read input from stdin
  const stdinText = await Bun.stdin.text();
  const { bundledJs, input, isDefineAlias } = JSON.parse(stdinText) as ExecutorInput;

  // Strip mcp-cli import
  const esmPattern = /^import\s+.*from\s+["']mcp-cli["'];?\s*$/gm;
  const cjsPattern = /^(?:var|const|let)\s+.*=\s*require\(["']mcp-cli["']\);?\s*$/gm;
  const stripped = bundledJs.replace(esmPattern, "").replace(cjsPattern, "");

  let captured: AliasDefinition | null = null;

  const ctx: AliasContext = {
    mcp: stubProxy,
    args:
      typeof input === "object" && input !== null
        ? Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : {},
    file: (path: string) => readFile(path, "utf-8"),
    json: async (path: string) => JSON.parse(await readFile(path, "utf-8")),
  };

  const injected = {
    defineAlias: (defOrFactory: AliasDefinition | ((dctx: { mcp: McpProxy; z: typeof z }) => AliasDefinition)) => {
      if (typeof defOrFactory === "function") {
        captured = defOrFactory({ mcp: stubProxy, z });
      } else {
        captured = defOrFactory;
      }
    },
    z,
    mcp: stubProxy,
    args: ctx.args,
    file: ctx.file,
    json: ctx.json,
  };

  const code = `const { defineAlias, z, mcp, args, file, json } = __mcp__;\n${stripped}`;
  const fn = new AsyncFunction("__mcp__", code);
  await fn(injected);

  if (!isDefineAlias) {
    // Freeform: side effects already executed
    process.stdout.write(JSON.stringify({ result: null }));
    return;
  }

  if (!captured) {
    throw new Error("Script did not call defineAlias()");
  }

  const def = captured as AliasDefinition;

  // Validate input
  let parsedInput = input;
  if (def.input) {
    const parseResult = def.input.safeParse(input);
    if (!parseResult.success) {
      throw new Error(`Invalid input: ${parseResult.error.message}`);
    }
    parsedInput = parseResult.data;
  }

  const output = await def.fn(parsedInput, ctx);

  // Validate output
  if (def.output) {
    const parseResult = def.output.safeParse(output);
    if (!parseResult.success) {
      throw new Error(`Invalid output: ${parseResult.error.message}`);
    }
    process.stdout.write(JSON.stringify({ result: parseResult.data }));
    return;
  }

  process.stdout.write(JSON.stringify({ result: output }));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
