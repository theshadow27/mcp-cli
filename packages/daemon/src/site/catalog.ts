// dotw-ignore no-import-cycles: seeds.ts imports type { Catalog } from this module; type-only back-edge
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

export type AuthMode = "bearer" | "cookie" | "auto";

/**
 * Extra response signals that mean "credentials are stale, wiggle and retry".
 * When both fields are set, both must match — APIs that 500 for unrelated
 * reasons shouldn't trigger a pointless refetch.
 */
export interface RetryOn {
  status?: number[];
  responseHeaderPresent?: string;
}

/**
 * Coerce an untrusted `retryOn` (MCP tool argument) into a well-formed RetryOn.
 * Malformed fields are dropped rather than persisted: a bad `status` would reach
 * `retryReason` as a non-array and throw inside the proxy's retry predicate.
 * Returns undefined when nothing usable survives, which means "401-only".
 */
export function normalizeRetryOn(value: unknown): RetryOn | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { status, responseHeaderPresent } = value as Record<string, unknown>;

  const out: RetryOn = {};
  if (Array.isArray(status)) {
    const codes = status.filter((s): s is number => typeof s === "number" && Number.isInteger(s));
    if (codes.length > 0) out.status = codes;
  }
  if (typeof responseHeaderPresent === "string" && responseHeaderPresent.length > 0) {
    out.responseHeaderPresent = responseHeaderPresent;
  }
  return out.status || out.responseHeaderPresent ? out : undefined;
}

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
  /**
   * Optional jq expression to transform the response before returning. Input is
   * the bare response body; the account's captured vars and the request params
   * are bound as the jq named args `$vars` / `$params`.
   */
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
  /**
   * How this call authenticates. "bearer" (default) injects a vault-picked
   * Bearer token daemon-side. "cookie" routes the fetch through the browser
   * page context so cookies are included automatically. "auto" tries bearer
   * first and falls back to cookie when the vault has no credentials.
   */
  authMode?: AuthMode;
  /**
   * Response signals beyond 401 that should trigger wiggle + retry. Unset means
   * 401-only. Used by APIs that validate session-scoped headers and answer with
   * a 5xx instead of 401 (e.g. OWA's OwaSerializationException).
   */
  retryOn?: RetryOn;
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
