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
import type {
  AliasContext,
  AliasDefinition,
  AliasMonitorEventInput,
  McpProxy,
  MonitorAliasDefinition,
  MonitorDefinition,
} from "./alias";
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

/**
 * Minimal metadata captured from a single defineMonitor() call in an alias file.
 * filePath and sourceHash are stored at the alias row level, not per-monitor.
 */
export interface MonitorAliasMetadata {
  name: string;
  description?: string;
}

/** Metadata extracted from a defineAlias script at save-time. */
export interface AliasMetadata {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** Any defineMonitor() calls found in the same file. */
  monitorDefs?: MonitorAliasMetadata[];
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
    // "mcp-cli" is the virtual alias-sdk module (injected at eval time).
    // "@mcp-cli/core" is this package — externalizing lets phase scripts
    // import core utilities (e.g. findModelInSprintPlan) and have them
    // resolved at eval time rather than bundled into the script.
    external: ["mcp-cli", "@mcp-cli/core"],
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
 * Handles:
 * 1. "mcp-cli" imports (ESM and CJS) — stripped; deps injected at eval time
 * 2. "@mcp-cli/core" imports — rewritten to destructure from `__mcp_core__`,
 *    which is the live core module passed into the AsyncFunction at eval time
 * 3. export blocks (`export { ... };` and `export default ...`) — Bun.build
 *    emits these; AsyncFunction bodies aren't modules, so they must go
 * 4. import.meta — replaced with a plain object stub
 */
export function stripModuleSyntax(bundledJs: string): string {
  // ESM: import { ... } from "mcp-cli";  or  import ... from "mcp-cli";
  const mcpCliEsm = /^import\b[^;]*?from\s+["']mcp-cli["'];?[ \t]*$/gms;
  const mcpCliEsmSideEffect = /^import\s+["']mcp-cli["'];?[ \t]*$/gm;
  const mcpCliCjs = /^(?:var|const|let)\s+.*=\s*require\(["']mcp-cli["']\);?\s*$/gm;

  // @mcp-cli/core: rewrite (don't strip) so named imports resolve at eval.
  // import { X, Y } from "@mcp-cli/core"  →  const { X, Y } = __mcp_core__;
  // Aliased specifiers ({ X as Y }) are converted to JS destructure ({ X: Y }).
  const coreEsmNamed = /^import\s*(\{[^}]*\})\s*from\s*["']@mcp-cli\/core["'];?[ \t]*$/gms;
  // import * as core from "@mcp-cli/core"  →  const core = __mcp_core__;
  const coreEsmNamespace = /^import\s*\*\s*as\s*(\w+)\s*from\s*["']@mcp-cli\/core["'];?[ \t]*$/gms;
  // import core from "@mcp-cli/core"  →  const core = __mcp_core__.default ?? __mcp_core__;
  const coreEsmDefault = /^import\s+(\w+)\s+from\s*["']@mcp-cli\/core["'];?[ \t]*$/gms;
  // Side-effect import: import "@mcp-cli/core";  →  drop
  const coreEsmSideEffect = /^import\s+["']@mcp-cli\/core["'];?[ \t]*$/gm;
  // CJS: var/const/let <binding> = require("@mcp-cli/core");
  const coreCjs = /^(var|const|let)\s+(\{[^}]*\}|\w+)\s*=\s*require\(["']@mcp-cli\/core["']\);?[ \t]*$/gm;

  const exportBlockPattern = /^export\s*\{[^}]*\};?[ \t]*$/gms;
  const exportDefaultPattern = /^export\s+default\b[^;]*;[ \t]*$/gms;

  const rewriteCoreNamed = (_m: string, specifiers: string): string => {
    // Convert { X as Y, Z } → { X: Y, Z } for JS destructure syntax.
    const inner = specifiers
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => s.replace(/\s+as\s+/, ": "))
      .join(", ");
    return `const { ${inner} } = __mcp_core__;`;
  };

  return bundledJs
    .replace(mcpCliEsm, "")
    .replace(mcpCliEsmSideEffect, "")
    .replace(mcpCliCjs, "")
    .replace(coreEsmNamed, rewriteCoreNamed)
    .replace(coreEsmNamespace, "const $1 = __mcp_core__;")
    .replace(coreEsmDefault, "const $1 = __mcp_core__.default ?? __mcp_core__;")
    .replace(coreEsmSideEffect, "")
    .replace(coreCjs, "$1 $2 = __mcp_core__;")
    .replace(exportBlockPattern, "")
    .replace(exportDefaultPattern, "")
    .replace(/\bimport\.meta\b/g, "({})");
}

/** @deprecated Use stripModuleSyntax — kept for backwards compatibility of test imports */
export const stripMcpCliImport = stripModuleSyntax;

/** Internal result from evalBundledJs — alias def plus any monitor definitions. */
interface EvalResult {
  aliasDef: AliasDefinition | null;
  monitorDefs: MonitorAliasDefinition[];
}

/**
 * Eval bundled alias JS with injected context, capturing defineAlias and defineMonitor calls.
 *
 * Shared core for extractMetadata, executeAliasBundled, validateAliasBundled, and evalMonitorBundled.
 * defineMonitor calls are captured as an array (a file may declare multiple monitors).
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
): Promise<EvalResult> {
  const stripped = stripModuleSyntax(bundledJs);

  // Lazy-load the @mcp-cli/core barrel at eval time. alias-bundle.ts is part
  // of core and re-exported from ./index, so static `import * as` would
  // self-cycle; dynamic import defers resolution until all sibling modules
  // are initialized.
  const coreBarrel = await import("./index");

  let aliasDef: AliasDefinition | null = null;
  const monitorDefs: MonitorAliasDefinition[] = [];

  const injected = {
    defineAlias: (defOrFactory: AliasDefinition | ((dctx: { mcp: McpProxy; z: typeof z }) => AliasDefinition)) => {
      if (typeof defOrFactory === "function") {
        aliasDef = defOrFactory({ mcp: ctx.mcp, z });
      } else {
        aliasDef = defOrFactory;
      }
    },
    defineMonitor: (def: MonitorAliasDefinition<AliasMonitorEventInput>) => {
      monitorDefs.push(def);
      return def;
    },
    z,
    mcp: ctx.mcp,
    args: ctx.args,
    file: ctx.file,
    json: ctx.json,
    parsePythonRepr,
  };

  const code = `const { defineAlias, defineMonitor, z, mcp, args, file, json, parsePythonRepr } = __mcp_inject__;\n${stripped}`;
  const fn = new AsyncFunction("__mcp_inject__", "__mcp_core__", code);

  if (timeoutMs !== undefined) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      fn(injected, coreBarrel),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("extractMetadata timed out")), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  } else {
    await fn(injected, coreBarrel);
  }

  return { aliasDef, monitorDefs };
}

/**
 * Extract metadata from bundled defineAlias JS without executing the handler.
 *
 * Evaluates the bundled code with a capture-only defineAlias function that
 * records the definition and extracts JSON Schemas from Zod types.
 * Also captures any defineMonitor() calls in the same file.
 */
export async function extractMetadata(bundledJs: string, timeoutMs = 5_000): Promise<AliasMetadata> {
  const { aliasDef, monitorDefs } = await evalBundledJs(
    bundledJs,
    { mcp: stubProxy, args: {}, file: () => Promise.resolve(""), json: () => Promise.resolve(null) },
    timeoutMs,
  );

  if (!aliasDef) {
    throw new Error("Script did not call defineAlias()");
  }

  const meta: AliasMetadata = {
    name: aliasDef.name,
    description: aliasDef.description ?? "",
  };

  try {
    if (aliasDef.input) {
      meta.inputSchema = z.toJSONSchema(aliasDef.input) as Record<string, unknown>;
    }
  } catch {
    /* schema conversion failed — skip */
  }

  try {
    if (aliasDef.output) {
      meta.outputSchema = z.toJSONSchema(aliasDef.output) as Record<string, unknown>;
    }
  } catch {
    /* schema conversion failed — skip */
  }

  if (monitorDefs.length > 0) {
    meta.monitorDefs = monitorDefs.map((m) => ({ name: m.name, description: m.description }));
  }

  return meta;
}

/**
 * Extract monitor metadata from a bundled alias file that may only contain
 * defineMonitor() calls (no defineAlias). Returns an empty array for freeform
 * scripts with no defineMonitor calls.
 */
export async function extractMonitorMetadata(bundledJs: string, timeoutMs = 5_000): Promise<MonitorAliasMetadata[]> {
  const { monitorDefs } = await evalBundledJs(
    bundledJs,
    { mcp: stubProxy, args: {}, file: () => Promise.resolve(""), json: () => Promise.resolve(null) },
    timeoutMs,
  );
  return monitorDefs.map((m) => ({ name: m.name, description: m.description }));
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
  const { aliasDef } = await evalBundledJs(bundledJs, ctx);

  if (!isDefineAlias) {
    return undefined;
  }

  if (!aliasDef) {
    throw new Error("Script did not call defineAlias()");
  }

  // Validate input
  let parsedInput = input;
  if (aliasDef.input) {
    const result = aliasDef.input.safeParse(input);
    if (!result.success) {
      throw new Error(`Invalid input: ${result.error.message}`);
    }
    parsedInput = result.data;
  }

  const output = await aliasDef.fn(parsedInput, ctx);

  // Validate output (warn, don't block — per #94)
  if (aliasDef.output) {
    const result = aliasDef.output.safeParse(output);
    if (!result.success) {
      console.error(`⚠ Output validation warning: ${result.error.message}`);
    }
    return result.success ? result.data : output;
  }

  return output;
}

/**
 * Eval bundled defineMonitor JS, returning the captured MonitorDefinition.
 * Used by the monitor executor subprocess.
 */
export async function evalMonitorBundled(bundledJs: string, mcp: McpProxy): Promise<MonitorDefinition> {
  const { monitorDefs } = await evalBundledJs(bundledJs, {
    mcp,
    args: {},
    file: () => Promise.resolve(""),
    json: () => Promise.resolve(null),
  });

  if (monitorDefs.length === 0) {
    throw new Error("Script did not call defineMonitor()");
  }

  // MonitorAliasDefinition (user-facing contract) and MonitorDefinition (runtime type) differ
  // only in their subscribe ctx signature. The executor subprocess bridges this at runtime.
  return monitorDefs[0] as unknown as MonitorDefinition;
}

/** Structured validation result for alias scripts. */
export interface AliasValidationResult {
  valid: boolean;
  aliasType: "defineAlias" | "defineMonitor" | "freeform";
  name?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** Any defineMonitor() calls found in the same file. */
  monitorDefs?: MonitorAliasMetadata[];
  errors: string[];
  warnings: string[];
}

/**
 * Validate a bundled defineAlias script, returning structured results.
 *
 * Checks:
 * - Script calls defineAlias() or defineMonitor()
 * - name and fn/subscribe are present
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

  let evalResult: EvalResult;
  try {
    evalResult = await evalBundledJs(
      bundledJs,
      { mcp: stubProxy, args: {}, file: () => Promise.resolve(""), json: () => Promise.resolve(null) },
      timeoutMs,
    );
  } catch (err) {
    result.valid = false;
    result.errors.push(`Failed to evaluate script: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  const { aliasDef, monitorDefs } = evalResult;

  if (monitorDefs.length > 0) {
    result.monitorDefs = monitorDefs.map((m) => ({ name: m.name, description: m.description }));
  }

  if (!aliasDef) {
    result.valid = false;
    result.errors.push("Script did not call defineAlias()");
    return result;
  }

  // Validate required fields
  if (!aliasDef.name || typeof aliasDef.name !== "string") {
    result.valid = false;
    result.errors.push("name: Missing or not a string");
  } else {
    result.name = aliasDef.name;
  }

  if (typeof aliasDef.fn !== "function") {
    result.valid = false;
    result.errors.push("fn: Missing or not a function");
  }

  result.description = aliasDef.description ?? "";

  // Validate input schema
  if (aliasDef.input) {
    if (typeof aliasDef.input.safeParse !== "function") {
      result.valid = false;
      result.errors.push(`input: Expected ZodType, got ${typeof aliasDef.input}`);
    } else {
      try {
        result.inputSchema = z.toJSONSchema(aliasDef.input) as Record<string, unknown>;
      } catch (err) {
        result.warnings.push(
          `input: Schema cannot convert to JSON Schema — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Validate output schema
  if (aliasDef.output) {
    if (typeof aliasDef.output.safeParse !== "function") {
      result.valid = false;
      result.errors.push(`output: Expected ZodType, got ${typeof aliasDef.output}`);
    } else {
      try {
        result.outputSchema = z.toJSONSchema(aliasDef.output) as Record<string, unknown>;
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
  export interface AliasMonitorEventInput {
    event: string;
    category?: string;
    [key: string]: unknown;
  }
  export interface MonitorAliasLogger {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug(msg: string): void;
  }
  export interface MonitorAliasContext {
    signal: AbortSignal;
    bus: { publish(input: AliasMonitorEventInput): void };
    logger: MonitorAliasLogger;
  }
  export interface MonitorAliasDefinition<E extends AliasMonitorEventInput = AliasMonitorEventInput> {
    name: string;
    description?: string;
    subscribe: (ctx: MonitorAliasContext) => AsyncIterable<E>;
  }
  export function defineMonitor<E extends AliasMonitorEventInput = AliasMonitorEventInput>(def: MonitorAliasDefinition<E>): MonitorAliasDefinition<E>;
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
