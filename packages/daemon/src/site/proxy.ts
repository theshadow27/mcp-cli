/**
 * Site call proxy: takes a ResolvedCall, picks a credential from the vault,
 * injects Bearer + passthrough headers, fetches, and returns the parsed response.
 *
 * 401s are retried once, optionally after running the site's wiggle script to
 * refresh tokens. If the caller doesn't pass `onWiggle`, the retry still happens
 * but without a token-refresh hook. A call can declare extra retry signals via
 * `NamedCall.retryOn` for APIs that answer stale session headers with a 5xx.
 */

import type { BrowserEngine } from "./browser/engine";
import type { RetryOn } from "./catalog";
import type { Credential, CredentialVault } from "./credentials";
import type { ResolvedCall } from "./resolver";

export interface ProxyCallOptions {
  site: string;
  resolved: ResolvedCall;
  audHints?: string[];
  /** Optional explicit aud to force credential selection. */
  aud?: string;
  /** Called once before the retry attempt; gives callers a chance to refresh tokens. */
  onWiggle?: () => Promise<void>;
  /** Catalog-declared extra retry signals (see NamedCall.retryOn). 401 is always retried. */
  retryOn?: RetryOn;
}

/**
 * "bearer" — the token itself was rejected, so the failed bearer is excluded on re-pick.
 * "session" — session-scoped headers are stale; the same bearer is usually still valid,
 * so re-pick must be allowed to return it with refreshed headers.
 */
export type RetryReason = "bearer" | "session";

export function retryReason(
  status: number,
  responseHeaders: Record<string, string>,
  retryOn?: RetryOn,
): RetryReason | null {
  if (status === 401) return "bearer";
  if (!retryOn?.status && !retryOn?.responseHeaderPresent) return null;

  const wanted = retryOn.responseHeaderPresent?.toLowerCase();
  const statusMatch = retryOn.status ? retryOn.status.includes(status) : true;
  const headerMatch = wanted ? Object.keys(responseHeaders).some((k) => k.toLowerCase() === wanted) : true;
  return statusMatch && headerMatch ? "session" : null;
}

function credentialChanged(before: Credential, after: Credential): boolean {
  return before.bearer !== after.bearer || JSON.stringify(before.headers) !== JSON.stringify(after.headers);
}

export interface ProxyCallResult {
  status: number;
  url: string;
  method: string;
  usedAud: string;
  responseHeaders: Record<string, string>;
  body: unknown;
}

const STRIP_HEADERS = new Set(["host", "content-length", "connection"]);

function normalizeKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function mergeHeaders(
  credHeaders: Record<string, string>,
  bearer: string,
  callHeaders: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {
    ...normalizeKeys(credHeaders),
    ...normalizeKeys(callHeaders),
    authorization: `Bearer ${bearer}`,
  };
  for (const k of Object.keys(merged)) {
    if (STRIP_HEADERS.has(k)) delete merged[k];
  }
  return merged;
}

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB

async function doFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: Record<string, string>; parsed: unknown }> {
  const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

  const declaredLength = r.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw new Error(`Response too large (${declaredLength} bytes, limit ${MAX_RESPONSE_BYTES})`);
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (r.body) {
    for await (const chunk of r.body) {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        throw new Error(`Response exceeded ${MAX_RESPONSE_BYTES} byte limit`);
      }
      chunks.push(chunk);
    }
  }
  const rawText = new TextDecoder().decode(Buffer.concat(chunks));

  let parsed: unknown = rawText;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // Non-JSON bodies are returned as a plain string.
  }
  return { status: r.status, parsed, headers: Object.fromEntries(r.headers.entries()) };
}

export async function proxyCall(vault: CredentialVault, opts: ProxyCallOptions): Promise<ProxyCallResult> {
  const { site, resolved, audHints = [], aud, onWiggle, retryOn } = opts;

  const pick = aud
    ? (vault.getAll(site).find((c) => c.aud === aud) ?? null)
    : vault.pickCredentialFor(resolved.url, resolved.method, audHints, site);

  if (!pick) {
    throw new Error(
      `No credentials available for site '${site}'. Run 'mcx site browser ${site}' to start a browser session (if you have previously authenticated, login is usually not required — your browser profile is preserved on disk).`,
    );
  }

  let usedAud = pick.aud;
  let merged = mergeHeaders(pick.headers, pick.bearer, resolved.headers);
  let result = await doFetch(resolved.url, resolved.method, merged, resolved.body);

  const reason = retryReason(result.status, result.headers, retryOn);
  if (reason) {
    try {
      await onWiggle?.();
    } catch {
      // Wiggle is advisory — don't fail the retry just because wiggle failed.
    }
    const excludeBearers = reason === "bearer" ? [pick.bearer] : [];
    const fresh = aud
      ? (vault.getAll(site).find((c) => c.aud === aud && !excludeBearers.includes(c.bearer)) ?? null)
      : vault.pickCredentialFor(resolved.url, resolved.method, audHints, site, { excludeBearers });
    // A session retry can legitimately re-pick the same bearer, but only if wiggle
    // actually refreshed something — otherwise the refetch is guaranteed to fail again.
    if (fresh && (reason === "bearer" || credentialChanged(pick, fresh))) {
      usedAud = fresh.aud;
      merged = mergeHeaders(fresh.headers, fresh.bearer, resolved.headers);
      result = await doFetch(resolved.url, resolved.method, merged, resolved.body);
    }
  }

  return {
    status: result.status,
    url: resolved.url,
    method: resolved.method,
    usedAud,
    responseHeaders: result.headers,
    body: result.parsed,
  };
}

export interface CookieProxyCallOptions {
  site: string;
  resolved: ResolvedCall;
  browser: BrowserEngine;
}

export async function cookieProxyCall(opts: CookieProxyCallOptions): Promise<ProxyCallResult> {
  const { site, resolved, browser } = opts;

  const { authorization: _stripped, ...headers } = normalizeKeys(resolved.headers);

  let cookies: import("./browser/engine").CookieEntry[];
  try {
    cookies = await browser.getCookies(resolved.url, site);
  } catch (err) {
    throw new Error(
      `Cookie-mode fetch failed for site '${site}': ${err instanceof Error ? err.message : err}. Ensure the browser is running and authenticated (\`mcx site browser\`).`,
    );
  }

  if (cookies.length === 0) {
    throw new Error(
      `No cookies found for '${resolved.url}' in site '${site}'. The browser session may have expired — run \`mcx site browser ${site}\` to re-authenticate.`,
    );
  }

  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const fetchHeaders: Record<string, string> = { ...headers, cookie: cookieHeader };

  const result = await doFetch(resolved.url, resolved.method, fetchHeaders, resolved.body);

  return {
    status: result.status,
    url: resolved.url,
    method: resolved.method,
    usedAud: "(cookie)",
    responseHeaders: result.headers,
    body: result.parsed,
  };
}
