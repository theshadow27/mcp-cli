/**
 * Scope detection — walk up from cwd and match against registered scope roots.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { options } from "./constants";

export interface ScopeMatch {
  name: string;
  root: string;
}

export interface DetectScopeDeps {
  scopesDir?: string;
}

/**
 * Detect the current scope by matching `cwd` against registered scope roots.
 *
 * Reads all `~/.mcp-cli/scopes/*.json` files and returns the most specific
 * match (longest root prefix), or `null` if no scope matches.
 */
export function detectScope(cwd?: string, deps: DetectScopeDeps = {}): ScopeMatch | null {
  const dir = resolve(cwd ?? process.cwd());
  const scopesDir = deps.scopesDir ?? options.SCOPES_DIR;

  if (!existsSync(scopesDir)) return null;

  let best: ScopeMatch | null = null;
  let bestLen = -1;

  const entries = readdirSync(scopesDir).filter((f) => f.endsWith(".json"));
  for (const entry of entries) {
    const name = entry.replace(/\.json$/, "");
    const filePath = `${scopesDir}/${entry}`;
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8")) as { root: string };
      const root = resolve(data.root);
      if ((dir === root || dir.startsWith(`${root}/`)) && root.length > bestLen) {
        best = { name, root };
        bestLen = root.length;
      }
    } catch {
      // Skip malformed scope files
    }
  }

  return best;
}

/**
 * List all registered scopes from `~/.mcp-cli/scopes/`.
 */
export function listScopes(deps: DetectScopeDeps = {}): ScopeMatch[] {
  const scopesDir = deps.scopesDir ?? options.SCOPES_DIR;
  if (!existsSync(scopesDir)) return [];

  const results: ScopeMatch[] = [];
  const entries = readdirSync(scopesDir).filter((f) => f.endsWith(".json"));
  for (const entry of entries) {
    const name = entry.replace(/\.json$/, "");
    const filePath = `${scopesDir}/${entry}`;
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8")) as { root: string };
      results.push({ name, root: resolve(data.root) });
    } catch {
      // Skip malformed scope files
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}
