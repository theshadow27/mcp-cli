/**
 * Client-side JQ filtering for output protection.
 *
 * At build time, a Bun.build plugin patches jq-web's Emscripten loader
 * to inline the WASM binary directly (via Module.wasmBinary), so no
 * filesystem extraction is needed at runtime.
 *
 * In dev mode (bun run), jq-web resolves from node_modules normally.
 */

// ============================================================================
// Configuration
// ============================================================================

/** Below this, pass response through unchanged */
export const SIZE_OK = 10 * 1024; // 10KB

/** Between OK and HINT, pass through + stderr hint */
export const SIZE_HINT = 20 * 1024; // 20KB

/** Above HINT, replace with structural analysis */
// Responses above SIZE_HINT get analyzed instead of returned

// ============================================================================
// JQ WASM (lazy-loaded)
// ============================================================================

type JqModule = { json: (data: unknown, filter: string) => unknown };
let jqPromise: Promise<JqModule | null> | null = null;
let jqUnavailableReason: string | null = null;

/** @internal Reset jq state for testing */
export function _resetJqStateForTesting(reason?: string): void {
  jqUnavailableReason = reason ?? null;
  jqPromise = null;
}

async function getJq(): Promise<JqModule | null> {
  if (jqUnavailableReason) return null;
  if (!jqPromise) {
    // In compiled binary: build plugin patches jq-web to export { ready: Promise }
    // instead of a raw Promise (avoids Bun's __toESM thenable breakage).
    // In dev mode: jq-web exports a raw Promise as default export.
    jqPromise = (async (): Promise<JqModule | null> => {
      try {
        const m = await import("jq-web");
        const exported = m.default;
        // Build plugin wraps in { ready: Promise }, dev mode is raw Promise
        const resolved = exported?.ready ? await exported.ready : await exported;
        return resolved as JqModule;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        jqUnavailableReason = message;
        jqPromise = null;
        return null;
      }
    })();
  }
  return jqPromise;
}

/** Thrown when jq-web WASM is not available */
export class JqUnavailableError extends Error {
  constructor(reason: string) {
    super(`jq-web unavailable: ${reason}`);
    this.name = "JqUnavailableError";
  }
}

/**
 * Apply a jq filter to data.
 * Throws JqUnavailableError if WASM failed to load.
 */
export async function applyJqFilter(data: unknown, filter: string): Promise<unknown> {
  const jq = await getJq();
  if (!jq) {
    throw new JqUnavailableError(jqUnavailableReason ?? "unknown");
  }
  return jq.json(data, filter);
}

// ============================================================================
// Structure Analysis (ported from phoenix-octovalve)
// ============================================================================

type PathStats = {
  samples: unknown[];
  count: number;
  bytes: number;
  type: string;
};

/**
 * Recursively analyze JSON structure, collecting stats per path.
 */
export function analyzeStructure(data: unknown): Map<string, PathStats> {
  const paths = new Map<string, PathStats>();

  function record(path: string, type: string, val: unknown, bytes: number): void {
    const existing = paths.get(path);
    if (existing) {
      existing.count++;
      existing.bytes += bytes;
      if (existing.samples.length < 3) {
        existing.samples.push(val);
      }
    } else {
      paths.set(path, { samples: [val], count: 1, bytes, type });
    }
  }

  function visit(val: unknown, path: string): void {
    if (val === null) {
      record(path, "null", null, 4);
    } else if (val === undefined) {
      record(path, "undefined", undefined, 9);
    } else if (Array.isArray(val)) {
      if (val.length === 0) {
        record(path, "array", [], 2);
      } else {
        for (const item of val) {
          visit(item, `${path}[]`);
        }
      }
    } else if (typeof val === "object") {
      const entries = Object.entries(val);
      if (entries.length === 0) {
        record(path, "object", {}, 2);
      } else {
        for (const [k, v] of entries) {
          visit(v, path ? `${path}.${k}` : k);
        }
      }
    } else {
      const type = typeof val;
      const serialized = JSON.stringify(val);
      record(path, type, val, serialized.length);
    }
  }

  visit(data, "");
  return paths;
}

/**
 * Format a sample value for display (truncate long strings).
 */
function formatSample(val: unknown): string {
  if (typeof val === "string") {
    if (val.length > 20) {
      return `"${val.slice(0, 17)}..."`;
    }
    return `"${val}"`;
  }
  if (val === null) return "null";
  if (val === undefined) return "undefined";
  return String(val);
}

/**
 * Generate a structural analysis string for large responses.
 */
export function generateAnalysis(data: unknown, sizeBytes: number): string {
  const paths = analyzeStructure(data);

  // Sort by path for readability
  const sorted = Array.from(paths.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  // Find heavy paths (>10% of total bytes)
  const totalBytes = Array.from(paths.values()).reduce((sum, p) => sum + p.bytes, 0);
  const heavyThreshold = totalBytes * 0.1;

  const lines: string[] = [`Response too large (${(sizeBytes / 1024).toFixed(1)}KB). Structure analysis:`, ""];

  for (const [path, stats] of sorted) {
    const samples = stats.samples.map(formatSample).join(", ");
    const countStr = stats.count > 3 ? `  (${stats.count} total)` : "";
    const heavy = stats.bytes > heavyThreshold ? " [heavy]" : "";
    lines.push(`  ${path || "(root)"}: ${stats.type} // [${samples}]${countStr}${heavy}`);
  }

  // Add suggested filters based on structure
  lines.push("", "Suggested jq filters:");

  // Find the main array path if any
  const arrayPaths = sorted.filter(([p]) => p.endsWith("[]"));
  if (arrayPaths.length > 0) {
    // Find the shortest array path (likely the main collection)
    const mainPath = arrayPaths.reduce((a, b) => (a[0].length < b[0].length ? a : b))[0];
    const basePath = mainPath.replace(/\[\]$/, "");
    const accessor = basePath ? `.${basePath}` : ".";

    lines.push(`  ${accessor}[:5]                        # first 5 items`);
    lines.push(`  ${accessor}[] | keys                   # show available fields`);
    lines.push(`  ${accessor} | length                   # count items`);

    // If there are nested fields, suggest a slim projection
    const nestedFields = sorted
      .filter(([p]) => p.startsWith(mainPath) && p !== mainPath)
      .map(([p]) => p.replace(`${mainPath}.`, "").split(".")[0])
      .filter((f, i, arr) => arr.indexOf(f) === i)
      .slice(0, 3);

    if (nestedFields.length > 0) {
      const projection = nestedFields.map((f) => (f.includes("[]") ? f.replace("[]", "") : f)).join(", ");
      lines.push(`  ${accessor}[] | {${projection}}          # slim projection`);
    }
  } else {
    lines.push("  keys                                 # show top-level keys");
    lines.push("  . | to_entries[:5]                   # first 5 entries");
  }

  lines.push("", "Use --jq '<filter>' to filter, or --full for raw output.");

  return lines.join("\n");
}
