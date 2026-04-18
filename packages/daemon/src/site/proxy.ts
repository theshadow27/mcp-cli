/**
 * Site call proxy: takes a ResolvedCall, picks a credential from the vault,
 * injects Bearer + passthrough headers, fetches, and returns the parsed response.
 *
 * 401s are retried once, optionally after running the site's wiggle script to
 * refresh tokens. If the caller doesn't pass `onWiggle`, the retry still happens
 * but without a token-refresh hook.
 */

import type { CredentialVault } from "./credentials";
import type { ResolvedCall } from "./resolver";

export interface ProxyCallOptions {
  site: string;
  resolved: ResolvedCall;
  audHints?: string[];
  /** Optional explicit aud to force credential selection. */
  aud?: string;
  /** Called once before the retry attempt; gives callers a chance to refresh tokens. */
  onWiggle?: () => Promise<void>;
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

function mergeHeaders(
  credHeaders: Record<string, string>,
  bearer: string,
  callHeaders: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...credHeaders, authorization: `Bearer ${bearer}`, ...callHeaders };
  for (const k of Object.keys(merged)) {
    if (STRIP_HEADERS.has(k.toLowerCase())) delete merged[k];
  }
  return merged;
}

async function doFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: Record<string, string>; parsed: unknown }> {
  const r = await fetch(url, { method, headers, body });
  const rawText = await r.text();
  let parsed: unknown = rawText;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // Non-JSON bodies are returned as a plain string.
  }
  return { status: r.status, parsed, headers: Object.fromEntries(r.headers.entries()) };
}

export async function proxyCall(vault: CredentialVault, opts: ProxyCallOptions): Promise<ProxyCallResult> {
  const { site, resolved, audHints = [], aud, onWiggle } = opts;

  const pick = aud
    ? (vault.getAll(site).find((c) => c.aud === aud) ?? null)
    : vault.pickCredentialFor(resolved.url, resolved.method, audHints, site);

  if (!pick) {
    throw new Error(`No credentials available for site '${site}'. Run 'mcx site browser ${site}' and complete login.`);
  }

  let usedAud = pick.aud;
  let merged = mergeHeaders(pick.headers, pick.bearer, resolved.headers);
  let result = await doFetch(resolved.url, resolved.method, merged, resolved.body);

  if (result.status === 401) {
    try {
      await onWiggle?.();
    } catch {
      // Wiggle is advisory — don't fail the retry just because wiggle failed.
    }
    const fresh = aud
      ? (vault.getAll(site).find((c) => c.aud === aud) ?? null)
      : vault.pickCredentialFor(resolved.url, resolved.method, audHints, site);
    if (fresh) {
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
