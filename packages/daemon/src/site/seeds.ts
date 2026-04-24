/**
 * Statically-imported seed data — embedded in the compiled binary by Bun's bundler.
 *
 * Dynamic filesystem reads (readdirSync / readFileSync against import.meta.dir)
 * don't survive `bun build --compile`, so every seed asset must appear as a
 * static import so the bundler can inline it.
 */

import type { Catalog } from "./catalog";
import type { PartialSiteConfig } from "./config";

// ── JSON seeds (bundled via resolveJsonModule) ──

import owaCatalog from "./seeds/owa/catalog.json";
import owaConfig from "./seeds/owa/config.json";

import teamsCatalog from "./seeds/teams/catalog.json";
import teamsConfig from "./seeds/teams/config.json";
import teamsSearchTemplate from "./seeds/teams/search-template.json";

// ── Wiggle scripts (bundled as text so they survive compilation) ──

// @ts-expect-error — Bun import attribute; tsc doesn't resolve { type: "text" }
import owaWiggleSrc from "./seeds/owa/wiggle.js" with { type: "text" };
// @ts-expect-error — Bun import attribute; tsc doesn't resolve { type: "text" }
import teamsWiggleSrc from "./seeds/teams/wiggle.js" with { type: "text" };

// ── Exported seed table ──

export interface SeedData {
  config: PartialSiteConfig;
  catalog: Catalog;
  searchTemplate?: Record<string, unknown>;
  wiggleSrc?: string;
}

export const BUILTIN_SEEDS: Record<string, SeedData> = {
  teams: {
    config: teamsConfig as PartialSiteConfig,
    catalog: teamsCatalog as unknown as Catalog,
    searchTemplate: teamsSearchTemplate as Record<string, unknown>,
    wiggleSrc: teamsWiggleSrc as string,
  },
  owa: {
    config: owaConfig as PartialSiteConfig,
    catalog: owaCatalog as unknown as Catalog,
    wiggleSrc: owaWiggleSrc as string,
  },
};
