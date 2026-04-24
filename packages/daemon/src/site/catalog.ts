/**
 * Named-call catalog: per-site JSON file mapping short names to HTTP requests.
 *
 * On first read, if the user's catalog.json is missing, the built-in seed
 * (site/seeds/<seed>/catalog.json) is copied in. Users and the sniffer both
 * mutate the catalog in place; manual edits are expected.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { siteCatalogPath } from "./paths";
import { BUILTIN_SEEDS } from "./seeds";

export interface NamedCall {
  name: string;
  url: string;
  method: string;
  description?: string;
  paramDocs?: Record<string, string>;
  /** Optional jq expression to transform input params into the request body. */
  jq_input?: string;
  /** Default body template (often a `search-template.json` imported by name). */
  body_default?: unknown;
  /** Optional jq expression to transform the response before returning. */
  jq_output?: string;
  headers?: Record<string, string>;
  /** Hostname hints used for credential audience matching. */
  audHints?: string[];
  /**
   * Named fetch filter applied MCP-side before proxying. Transforms the
   * constructed {url, method, headers, body} before it hits the credential proxy.
   * e.g. "owa-urlpostdata" encodes the body into an x-owa-urlpostdata header.
   */
  fetchFilter?: string;
}

export type Catalog = Record<string, NamedCall>;

function loadSeed(seedName: string): Catalog {
  const seed = BUILTIN_SEEDS[seedName];
  if (!seed) return {};
  const raw = structuredClone(seed.catalog);
  if (seed.searchTemplate) {
    for (const call of Object.values(raw)) {
      if (call.body_default === null) {
        call.body_default = structuredClone(seed.searchTemplate);
      }
    }
  }
  return raw;
}

export function loadCatalog(site: string, seedName?: string): Catalog {
  const file = siteCatalogPath(site);
  mkdirSync(dirname(file), { recursive: true });

  if (!existsSync(file)) {
    const seed = loadSeed(seedName ?? site);
    writeFileSync(file, JSON.stringify(seed, null, 2));
    return { ...seed };
  }
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Catalog;
  } catch (e) {
    throw new Error(`Failed to parse ${file}: ${e instanceof Error ? e.message : e}`);
  }
}

export function saveCatalog(site: string, catalog: Catalog): void {
  const file = siteCatalogPath(site);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(catalog, null, 2));
}

export function upsertCall(site: string, call: NamedCall, seedName?: string): Catalog {
  const catalog = loadCatalog(site, seedName);
  catalog[call.name] = call;
  saveCatalog(site, catalog);
  return catalog;
}

export function removeCall(site: string, name: string, seedName?: string): boolean {
  const catalog = loadCatalog(site, seedName);
  if (!(name in catalog)) return false;
  delete catalog[name];
  saveCatalog(site, catalog);
  return true;
}
