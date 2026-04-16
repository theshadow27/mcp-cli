/**
 * Alias bundling and execution via Bun.build + AsyncFunction eval.
 *
 * Replaces the Worker + bun.plugin() virtual module approach with:
 * 1. Bun.build to bundle alias scripts (externalizing "mcp-cli")
 * 2. stripModuleSyntax to remove module-level constructs from bundled output
 * 3. AsyncFunction eval with injected dependencies
 *
 * This eliminates segfaults caused by concurrent import() with cache-busting
 * from worker threads (#577).
 */

import { z } from "zod/v4";
import type { AliasContext, AliasDefinition, McpProxy } from "./alias";
import { parsePythonRepr } from "./python-repr";

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
  // Read source once for hashing — Bun.build re-reads from path (unavoidable with path-based API)
  const sourceContent = await Bun.file(sourcePath).arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(sourceContent);
  const sourceHash = hasher.digest("hex");

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
 * Strip module syntax from Bun.build output so it can run inside AsyncFunction.
 *
 * Removes:
 * 1. "mcp-cli" imports (ESM and CJS) — dependencies are injected at eval time
 * 2. export blocks (`export { ... };` and `export default ...`) — Bun.build adds
 *    these for the module's default export, but AsyncFunction bodies aren't modules
 * 3. import.meta references — replaced with a plain object stub
 */
export function stripModuleSyntax(bundledJs: string): string {
  // ESM: import { ... } from "mcp-cli";  or  import ... from "mcp-cli";
  // Uses [^;]*? to handle multi-line imports from Bun.build (e.g. import {\n  defineAlias,\n  z\n} from "mcp-cli";)
  const esmPattern = /^import\b[^;]*?from\s+["']mcp-cli["'];?[ \t]*$/gms;
  // CJS: var/const/let { ... } = require("mcp-cli");
  const cjsPattern = /^(?:var|const|let)\s+.*=\s*require\(["']mcp-cli["']\);?\s*$/gm;
  // export { ... };  (possibly multi-line, as Bun.build emits for default exports)
  const exportBlockPattern = /^export\s*\{[^}]*\};?[ \t]*$/gms;
  // export default <expr>;
  const exportDefaultPattern = /^export\s+default\b[^;]*;?[ \t]*$/gm;

  return bundledJs
    .replace(esmPattern, "")
    .replace(cjsPattern, "")
    .replace(exportBlockPattern, "")
    .replace(exportDefaultPattern, "")
    .replace(/\bimport\.meta\b/g, "({})");
}

/** @deprecated Use stripModuleSyntax — kept for backwards compatibility of test imports */
export const stripMcpCliImport = stripModuleSyntax;

/**
 * Eval bundled alias JS with injected context, capturing any defineAlias call.
 *
 * Shared core for extractMetadata and executeAliasBundled.
 * Returns the captured AliasDefinition, or null for freeform scripts.
 */
async function evalBundledJs(
  bundledJs: string,
  ctx: {
    mcp: McpProxy;
    args: Record<string, string>;
    file: (p: string) => Promise<string>;
    json: (p: string) => Promise<unknown>;
  },
  timeoutMs?: number,
): Promise<AliasDefinition | null> {
  const stripped = stripModuleSyntax(bundledJs);

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
    parsePythonRepr,
  };

  const code = `const { defineAlias, z, mcp, args, file, json, parsePythonRepr } = __mcp_inject__;\n${stripped}`;
  const fn = new AsyncFunction("__mcp_inject__", code);

  if (timeoutMs !== undefined) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      fn(injected),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("extractMetadata timed out")), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  } else {
    await fn(injected);
  }

  return captured;
}

/**
 * Extract metadata from bundled defineAlias JS without executing the handler.
 *
 * Evaluates the bundled code with a capture-only defineAlias function that
 * records the definition and extracts JSON Schemas from Zod types.
 */
export async function extractMetadata(bundledJs: string, timeoutMs = 5_000): Promise<AliasMetadata> {
  const captured = await evalBundledJs(
    bundledJs,
    { mcp: stubProxy, args: {}, file: () => Promise.resolve(""), json: () => Promise.resolve(null) },
    timeoutMs,
  );

  if (!captured) {
    throw new Error("Script did not call defineAlias()");
  }

  const meta: AliasMetadata = {
    name: captured.name,
    description: captured.description ?? "",
  };

  try {
    if (captured.input) {
      meta.inputSchema = z.toJSONSchema(captured.input) as Record<string, unknown>;
    }
  } catch {
    /* schema conversion failed — skip */
  }

  try {
    if (captured.output) {
      meta.outputSchema = z.toJSONSchema(captured.output) as Record<string, unknown>;
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
  const captured = await evalBundledJs(bundledJs, ctx);

  if (!isDefineAlias) {
    // Freeform: side effects already executed during eval
    return undefined;
  }

  if (!captured) {
    throw new Error("Script did not call defineAlias()");
  }

  // Validate input
  let parsedInput = input;
  if (captured.input) {
    const result = captured.input.safeParse(input);
    if (!result.success) {
      throw new Error(`Invalid input: ${result.error.message}`);
    }
    parsedInput = result.data;
  }

  const output = await captured.fn(parsedInput, ctx);

  // Validate output (warn, don't block — per #94)
  if (captured.output) {
    const result = captured.output.safeParse(output);
    if (!result.success) {
      console.error(`⚠ Output validation warning: ${result.error.message}`);
    }
    // Always return consistently: coerced data on success, raw output on failure
    return result.success ? result.data : output;
  }

  return output;
}

/** Structured validation result for alias scripts. */
export interface AliasValidationResult {
  valid: boolean;
  aliasType: "defineAlias" | "freeform";
  name?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a bundled defineAlias script, returning structured results.
 *
 * Checks:
 * - Script calls defineAlias()
 * - name and fn are present
 * - input/output are valid Zod schemas (can safeParse)
 * - input/output convert to JSON Schema
 */
export async function validateAliasBundled(bundledJs: string, timeoutMs = 5_000): Promise<AliasValidationResult> {
  const result: AliasValidationResult = {
    valid: true,
    aliasType: "defineAlias",
    errors: [],
    warnings: [],
  };

  let captured: AliasDefinition | null;
  try {
    captured = await evalBundledJs(
      bundledJs,
      { mcp: stubProxy, args: {}, file: () => Promise.resolve(""), json: () => Promise.resolve(null) },
      timeoutMs,
    );
  } catch (err) {
    result.valid = false;
    result.errors.push(`Failed to evaluate script: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  if (!captured) {
    result.valid = false;
    result.errors.push("Script did not call defineAlias()");
    return result;
  }

  // Validate required fields
  if (!captured.name || typeof captured.name !== "string") {
    result.valid = false;
    result.errors.push("name: Missing or not a string");
  } else {
    result.name = captured.name;
  }

  if (typeof captured.fn !== "function") {
    result.valid = false;
    result.errors.push("fn: Missing or not a function");
  }

  result.description = captured.description ?? "";

  // Validate input schema
  if (captured.input) {
    if (typeof captured.input.safeParse !== "function") {
      result.valid = false;
      result.errors.push(`input: Expected ZodType, got ${typeof captured.input}`);
    } else {
      try {
        result.inputSchema = z.toJSONSchema(captured.input) as Record<string, unknown>;
      } catch (err) {
        result.warnings.push(
          `input: Schema cannot convert to JSON Schema — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Validate output schema
  if (captured.output) {
    if (typeof captured.output.safeParse !== "function") {
      result.valid = false;
      result.errors.push(`output: Expected ZodType, got ${typeof captured.output}`);
    } else {
      try {
        result.outputSchema = z.toJSONSchema(captured.output) as Record<string, unknown>;
      } catch (err) {
        result.warnings.push(
          `output: Schema cannot convert to JSON Schema — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return result;
}

/**
 * Stub declaration for the "mcp-cli" virtual module, used during tsc validation
 * so that freeform alias imports resolve without errors.
 */
const MCP_CLI_STUB_DTS = `
declare module "mcp-cli" {
  export const mcp: Record<string, Record<string, (args?: Record<string, unknown>) => Promise<unknown>>>;
  export const args: Record<string, string>;
  export function file(path: string): Promise<string>;
  export function json(path: string): Promise<unknown>;
  export function defineAlias(def: unknown): void;
  export const z: typeof import("zod/v4").z;
}
`.trimStart();

/** Minimal tsconfig for tsc validation of freeform alias scripts. */
const TSC_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      noEmit: true,
      strict: false,
      skipLibCheck: true,
      paths: { "mcp-cli": ["./mcp-cli.d.ts"] },
    },
    include: ["*.ts"],
  },
  null,
  2,
);

/**
 * Parse tsc diagnostic lines into human-readable messages.
 * Only includes lines matching the tsc diagnostic format: file(line,col): error TSxxxx: message
 * Filters out bunx/npm noise (e.g. "Resolving dependencies").
 */
function parseTscDiagnostics(output: string, scriptBasename: string): string[] {
  // Match: file.ts(line,col): error TS1234: message  OR  error TS1234: message
  const diagPattern = /^(?:.*\(\d+,\d+\):\s*)?error\s+TS\d+:/;
  const diagnostics: string[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !diagPattern.test(trimmed)) continue;
    // Simplify by stripping the temp file path prefix
    const simplified = trimmed.replace(new RegExp(`^${escapeRegExp(scriptBasename)}\\(`), "(");
    diagnostics.push(simplified);
  }
  return diagnostics;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Validate a freeform alias script using `bunx tsc --noEmit`.
 *
 * Creates a temp directory with the script, a stub mcp-cli.d.ts, and a
 * tsconfig.json, then runs tsc. Diagnostics are returned as warnings.
 * Returns valid: true unless tsc crashes (signal kill, not diagnostic errors).
 */
export async function validateFreeformTsc(
  sourcePath: string,
  timeoutMs = 10_000,
): Promise<{ warnings: string[]; timedOut: boolean }> {
  const { mkdtempSync, writeFileSync, cpSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, basename } = await import("node:path");

  const tmpDir = mkdtempSync(join(tmpdir(), "mcp-alias-tsc-"));
  const scriptName = basename(sourcePath);

  try {
    // Copy alias source and write support files
    cpSync(sourcePath, join(tmpDir, scriptName));
    writeFileSync(join(tmpDir, "mcp-cli.d.ts"), MCP_CLI_STUB_DTS);
    writeFileSync(join(tmpDir, "tsconfig.json"), TSC_TSCONFIG);

    const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
      cwd: tmpDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    clearTimeout(timer);

    await proc.exited;

    if (timedOut) {
      return { warnings: ["tsc validation timed out"], timedOut: true };
    }

    // Parse diagnostics from stdout (tsc writes diagnostics to stdout)
    const output = stdout || stderr;
    const warnings = parseTscDiagnostics(output, scriptName);

    return { warnings, timedOut: false };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

// AsyncFunction constructor (not directly accessible as a global)
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;
