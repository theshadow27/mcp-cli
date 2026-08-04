/**
 * Per-mailbox / per-account variable capture from sniffer output.
 *
 * Some sites need values that are specific to the signed-in account and can't
 * ship in a seed catalog — OWA's concrete `BaseFolderId` UUID and the
 * `x-anchormailbox` PUID, for example. Those values are already flowing past
 * the harvested browser session, so rather than asking the operator to copy
 * them out of DevTools, a site declares `captureVars` in its config and this
 * module extracts them from the capture files the sniffer already writes to
 * `sites/<site>/captures/`.
 *
 * Each spec is a jq expression evaluated against a normalized sample document
 * (see `CaptureSample`), so adjusting where a value lives on the wire is a
 * seed-JSON edit, not a code change.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CaptureVarSpec } from "./config";
import { siteVarsPath } from "./paths";

/** jq runner shape — structurally compatible with transforms.ts `JqRunner`. */
export type CaptureJq = (expression: string, input: string) => Promise<string>;

/** Normalized view of one capture file, and the document jq expressions run against. */
export interface CaptureSample {
  file: string;
  url: string;
  method: string;
  status: number;
  /** Lower-cased header names, so jq expressions don't have to guess the casing. */
  requestHeaders: Record<string, string>;
  /** Parsed JSON when the post data (or decoded x-owa-urlpostdata) is JSON; raw string otherwise. */
  requestBody: unknown;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
}

export interface CaptureResult {
  vars: Record<string, string>;
  missing: string[];
  scanned: number;
}

/**
 * Default number of capture files to scan, newest first.
 *
 * Authoritative values often ride a session-bootstrap response that is issued
 * once per sign-in, so it sits far behind the steady-state request chatter. The
 * default has to be deep enough to reach it; the `urlPrefilter` below is what
 * keeps that depth cheap.
 */
export const DEFAULT_CAPTURE_SCAN_LIMIT = 1000;

/** Hard ceiling on the scan, so a caller-supplied limit can't turn into a full-corpus walk. */
export const MAX_CAPTURE_SCAN_LIMIT = 5000;

/**
 * Coerce a caller-supplied scan limit into `1..MAX_CAPTURE_SCAN_LIMIT`.
 *
 * The site worker is single-threaded: an unbounded limit lets one capture call
 * stall every other call on the site for the duration of a corpus walk.
 */
export function clampScanLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_CAPTURE_SCAN_LIMIT;
  return Math.min(MAX_CAPTURE_SCAN_LIMIT, Math.max(1, Math.floor(limit)));
}

interface RawCaptureFile {
  _meta?: { url?: string; method?: string; status?: number };
  requestHeaders?: Record<string, string>;
  requestPostData?: string | null;
  responseHeaders?: Record<string, string>;
  body?: unknown;
}

function lowerKeys(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v;
  return out;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Resolve a request body from post data, falling back to OWA's
 * `x-owa-urlpostdata` header — the exact inverse of the `owa-urlpostdata`
 * fetch filter in transforms.ts, which is how OWA sends JSON bodies.
 */
function requestBodyOf(postData: string | null | undefined, headers: Record<string, string>): unknown {
  if (typeof postData === "string" && postData.length > 0) return tryJson(postData);
  const urlPostData = headers["x-owa-urlpostdata"];
  if (typeof urlPostData === "string" && urlPostData.length > 0) {
    try {
      return tryJson(decodeURIComponent(urlPostData));
    } catch {
      return tryJson(urlPostData);
    }
  }
  return null;
}

export function buildSample(file: string, raw: unknown): CaptureSample | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as RawCaptureFile;
  const url = rec._meta?.url;
  if (typeof url !== "string") return null;
  const requestHeaders = lowerKeys(rec.requestHeaders);
  return {
    file,
    url,
    method: rec._meta?.method ?? "",
    status: rec._meta?.status ?? 0,
    requestHeaders,
    requestBody: requestBodyOf(rec.requestPostData, requestHeaders),
    responseHeaders: lowerKeys(rec.responseHeaders),
    responseBody: rec.body ?? null,
  };
}

/**
 * Union of the specs' `urlMatch` patterns, for use as a raw-text prefilter.
 *
 * A capture file whose text doesn't contain any spec's URL pattern cannot
 * satisfy any spec, so it can be skipped before `JSON.parse` — which matters
 * because a capture corpus is mostly large script and telemetry bodies. This is
 * sound only because a URL that matches a pattern implies the file text does
 * too; that implication breaks for anchored patterns, and for a spec with no
 * `urlMatch` at all, so both cases disable the prefilter.
 */
export function captureUrlPrefilter(specs: CaptureVarSpec[]): RegExp | null {
  const patterns: string[] = [];
  for (const spec of specs) {
    if (!spec?.urlMatch) return null;
    if (/[$^]/.test(spec.urlMatch)) return null;
    patterns.push(spec.urlMatch);
  }
  if (patterns.length === 0) return null;
  try {
    return new RegExp(patterns.map((p) => `(?:${p})`).join("|"), "i");
  } catch {
    return null;
  }
}

/**
 * Read capture files newest-first. Sniffer filenames are prefixed with an
 * ISO timestamp token, so a descending lexicographic sort is chronological.
 *
 * `urlPrefilter` only skips work — it never changes which sample satisfies a
 * spec, because `extractVars` re-checks each spec's own `urlMatch`.
 */
export function readCaptureSamples(
  dir: string,
  limit = DEFAULT_CAPTURE_SCAN_LIMIT,
  urlPrefilter: RegExp | null = null,
): CaptureSample[] {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit);

  const samples: CaptureSample[] = [];
  for (const name of names) {
    let sample: CaptureSample | null = null;
    try {
      const text = readFileSync(join(dir, name), "utf-8");
      if (urlPrefilter && !urlPrefilter.test(text)) continue;
      sample = buildSample(name, JSON.parse(text));
    } catch {
      // A partially-written or non-JSON capture file must not abort the scan.
      sample = null;
    }
    if (sample) samples.push(sample);
  }
  return samples;
}

/** Interpret jq stdout as a captured value. Empty output, null, and non-scalars are misses. */
function valueFromJqOutput(stdout: string): string | null {
  const text = stdout.trim();
  if (text.length === 0) return null;
  // jq -c can emit several lines when the expression yields multiple results.
  const first = text.split("\n")[0].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(first);
  } catch {
    return first.length > 0 ? first : null;
  }
  if (typeof parsed === "string") return parsed.length > 0 ? parsed : null;
  if (typeof parsed === "number" || typeof parsed === "boolean") return String(parsed);
  return null;
}

/** Evaluate each spec against the samples, newest first; the first non-empty scalar wins. */
export async function extractVars(
  specs: CaptureVarSpec[],
  samples: CaptureSample[],
  jq: CaptureJq,
): Promise<CaptureResult> {
  const vars: Record<string, string> = {};
  const missing: string[] = [];

  for (const spec of specs) {
    if (!spec?.name || !spec.jq) continue;
    let urlRe: RegExp | null = null;
    if (spec.urlMatch) {
      try {
        urlRe = new RegExp(spec.urlMatch, "i");
      } catch {
        // An unusable urlMatch must not silently widen the search.
        missing.push(spec.name);
        continue;
      }
    }

    let found: string | null = null;
    for (const sample of samples) {
      if (urlRe && !urlRe.test(sample.url)) continue;
      let stdout: string;
      try {
        stdout = await jq(spec.jq, JSON.stringify(sample));
      } catch {
        // jq exits non-zero on a type error against an unrelated sample; keep scanning.
        continue;
      }
      found = valueFromJqOutput(stdout);
      if (found !== null) break;
    }

    if (found === null) missing.push(spec.name);
    else vars[spec.name] = found;
  }

  return { vars, missing, scanned: samples.length };
}

/** Captured variables for a site. Missing or unparseable files read as empty. */
export function loadVars(site: string): Record<string, string> {
  const file = siteVarsPath(site);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveVars(site: string, vars: Record<string, string>): void {
  const file = siteVarsPath(site);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(vars, null, 2));
}

/** Drop every captured var for a site. Returns the names removed. */
export function clearVars(site: string): string[] {
  const existing = loadVars(site);
  const names = Object.keys(existing);
  const file = siteVarsPath(site);
  if (existsSync(file)) rmSync(file);
  return names;
}

/**
 * Fold a capture result into the stored vars.
 *
 * A capture run is *authoritative for the names it declares*: each declared
 * name is dropped first and only re-added if this run actually extracted it. A
 * merge that only ever adds keys makes a wrong value permanent — re-capturing
 * after fixing the spec would leave the bad value in place, since the fixed
 * spec's output would be written under the same name only if it succeeded and
 * the stale one would survive if it didn't. Names not declared by any spec are
 * left untouched, because those are operator-authored.
 */
export function mergeCapturedVars(
  existing: Record<string, string>,
  specs: CaptureVarSpec[],
  captured: Record<string, string>,
): Record<string, string> {
  const out = { ...existing };
  for (const spec of specs) {
    if (!spec?.name) continue;
    delete out[spec.name];
  }
  for (const [k, v] of Object.entries(captured)) out[k] = v;
  return out;
}
