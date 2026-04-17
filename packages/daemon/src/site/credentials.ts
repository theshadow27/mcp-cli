/**
 * Per-site credential vault. Captures Bearer tokens from observed requests,
 * indexes them by JWT `aud`, and picks the best match for a target URL.
 *
 * Scoring (pickCredentialFor):
 *   +2000 aud hint substring match
 *   +1000 same host
 *   +10 per matching path segment from root
 *   +5   aud path-last-segment appears in target path
 *   +2   method match
 *   +(iat / 1e12) freshness tiebreak
 */

import type { CapturedRequest } from "./browser/engine";

export interface JwtClaims {
  aud?: string;
  iss?: string;
  exp?: number;
  iat?: number;
  scp?: string;
  tid?: string;
  oid?: string;
  upn?: string;
  appid?: string;
  ver?: string | number;
  [k: string]: unknown;
}

export interface Credential {
  aud: string;
  bearer: string;
  claims: JwtClaims;
  headers: Record<string, string>;
  sampleUrl: string;
  sampleMethod: string;
  lastSeenAt: string;
  observations: number;
}

export class CredentialVault {
  private tables = new Map<string, Map<string, Credential>>();

  private tableFor(site: string): Map<string, Credential> {
    let t = this.tables.get(site);
    if (!t) {
      t = new Map();
      this.tables.set(site, t);
    }
    return t;
  }

  noteRequest(site: string, req: CapturedRequest): void {
    const authz = req.headers.authorization ?? req.headers.Authorization;
    if (!authz || !/^bearer /i.test(authz)) return;

    const token = authz.slice(7).trim();
    const claims = decodeJwt(token);
    if (!claims) return;

    // Skip odd token versions (e.g. Exchange callback tokens embed a user access token and are 10KB+).
    const ver = String(claims.ver ?? "");
    if (ver && !ver.startsWith("1.") && !ver.startsWith("2.")) return;

    const aud = typeof claims.aud === "string" ? claims.aud : "unknown";
    const table = this.tableFor(site);
    const prev = table.get(aud);

    let cred: Credential = {
      aud,
      bearer: token,
      claims,
      headers: sanitizeHeaders(req.headers),
      sampleUrl: req.url,
      sampleMethod: req.method,
      lastSeenAt: new Date().toISOString(),
      observations: (prev?.observations ?? 0) + 1,
    };
    // If the new token is older than the existing one, keep the existing bearer but bump observations.
    if (prev?.claims.iat && typeof claims.iat === "number" && claims.iat < prev.claims.iat) {
      cred = {
        ...cred,
        bearer: prev.bearer,
        claims: prev.claims,
        headers: prev.headers,
        sampleUrl: prev.sampleUrl,
        sampleMethod: prev.sampleMethod,
      };
    }
    table.set(aud, cred);
  }

  getAll(site?: string): Credential[] {
    const iatSort = (a: Credential, b: Credential): number => (b.claims.iat ?? 0) - (a.claims.iat ?? 0);
    if (site) return [...this.tableFor(site).values()].sort(iatSort);
    const all: Credential[] = [];
    for (const t of this.tables.values()) all.push(...t.values());
    return all.sort(iatSort);
  }

  pickCredentialFor(
    targetUrl: string,
    targetMethod = "GET",
    audHints: string[] = [],
    site?: string,
  ): Credential | null {
    const all = this.getAll(site);
    if (all.length === 0) return null;

    let target: URL;
    try {
      target = new URL(targetUrl);
    } catch {
      return all[0];
    }
    const targetSegs = target.pathname.split("/").filter(Boolean);
    const targetPathLower = target.pathname.toLowerCase();
    const hintsLower = audHints.map((h) => h.toLowerCase()).filter(Boolean);

    let best: Credential | null = null;
    let bestScore = -1;

    for (const c of all) {
      let sample: URL;
      try {
        sample = new URL(c.sampleUrl);
      } catch {
        continue;
      }
      let score = 0;
      if (hintsLower.length > 0) {
        const audLower = c.aud.toLowerCase();
        if (hintsLower.some((h) => audLower.includes(h))) score += 2000;
      }
      if (sample.host === target.host) score += 1000;

      const sampleSegs = sample.pathname.split("/").filter(Boolean);
      for (let i = 0; i < Math.min(targetSegs.length, sampleSegs.length); i++) {
        if (sampleSegs[i] === targetSegs[i]) score += 10;
        else break;
      }

      try {
        const audUrl = c.aud.startsWith("http") ? new URL(c.aud) : null;
        if (audUrl) {
          const audSegs = audUrl.pathname.split("/").filter(Boolean);
          const last = audSegs[audSegs.length - 1];
          if (last && last.length >= 4 && targetPathLower.includes(last.toLowerCase())) score += 5;
        }
      } catch {
        // aud may not be a URL; ignore.
      }

      if ((c.sampleMethod || "").toUpperCase() === targetMethod.toUpperCase()) score += 2;
      score += (c.claims.iat ?? 0) / 1e12;

      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  clear(site?: string): void {
    if (site) this.tables.delete(site);
    else this.tables.clear();
  }
}

export function decodeJwt(token: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf-8")) as JwtClaims;
  } catch {
    return null;
  }
}

function sanitizeHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k.toLowerCase()] = v.length > 8000 ? `${v.slice(0, 8000)}…(truncated)` : v;
  }
  return out;
}

export function summarizeCredential(c: Credential): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const expiresInSec = typeof c.claims.exp === "number" ? c.claims.exp - now : null;
  return {
    aud: c.aud,
    upn: c.claims.upn,
    tid: c.claims.tid,
    oid: c.claims.oid,
    scp: c.claims.scp,
    appid: c.claims.appid,
    iss: c.claims.iss,
    exp: c.claims.exp,
    expiresInSec,
    lastSeenAt: c.lastSeenAt,
    observations: c.observations,
    sampleMethod: c.sampleMethod,
    sampleUrl: c.sampleUrl,
    bearerPrefix: `${c.bearer.slice(0, 16)}…`,
    bearerBytes: c.bearer.length,
    headersPresent: Object.keys(c.headers),
  };
}
