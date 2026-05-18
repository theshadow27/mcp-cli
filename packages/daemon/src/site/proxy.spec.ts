import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CapturedRequest } from "./browser/engine";
import { CredentialVault } from "./credentials";
import { proxyCall } from "./proxy";
import type { ResolvedCall } from "./resolver";

function makeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.`;
}

function authReq(url: string, token: string): CapturedRequest {
  return { url, method: "GET", resourceType: "xhr", headers: { authorization: `Bearer ${token}` }, postData: null };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // noop — each test installs its own fetch mock
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("proxyCall", () => {
  test("usedAud reflects the credential that authorized the final fetch after 401 retry", async () => {
    const vault = new CredentialVault();
    const tokenA = makeJwt({ aud: "https://a.example/", iat: 100 });
    const tokenB = makeJwt({ aud: "https://b.example/", iat: 200 });
    vault.noteRequest("demo", authReq("https://a.example/v1", tokenA));
    vault.noteRequest("demo", authReq("https://b.example/v1", tokenB));

    // First fetch returns 401. onWiggle simulates a token refresh for B (new bearer, higher iat).
    // After wiggle, re-pick must find the refreshed B (different bearer) and retry successfully.
    let call = 0;
    globalThis.fetch = mock(async () => {
      call += 1;
      if (call === 1) return new Response("", { status: 401 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const onWiggle = async (): Promise<void> => {
      // Simulate a token refresh: new bearer with higher iat.
      const refreshedTokenB = makeJwt({ aud: "https://b.example/", iat: 300 });
      vault.clear("demo");
      vault.noteRequest("demo", authReq("https://b.example/v1", refreshedTokenB));
    };

    const resolved: ResolvedCall = {
      url: "https://b.example/v1/thing",
      method: "GET",
      headers: {},
      consumedParams: [],
      residualParams: [],
    };

    const result = await proxyCall(vault, { site: "demo", resolved, audHints: ["b.example"], onWiggle });

    expect(result.status).toBe(200);
    // Before the fix, this was pick.aud (whatever won the first selection).
    // After the fix, it must be fresh.aud — the one that actually authorized the successful call.
    expect(result.usedAud).toBe("https://b.example/");
  });

  test("mergeHeaders: callHeaders content-type wins over credHeaders, injected bearer always wins over callHeaders Authorization", async () => {
    const vault = new CredentialVault();
    const token = makeJwt({ aud: "https://a.example/", iat: 100 });
    vault.noteRequest("demo", authReq("https://a.example/v1", token));
    const cred = vault.getAll("demo")[0];
    if (!cred) throw new Error("no cred");
    cred.headers["Content-Type"] = "application/octet-stream";

    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const resolved: ResolvedCall = {
      url: "https://a.example/v1/upload",
      method: "POST",
      // Mixed-case content-type should win over cred; attacker-supplied Authorization must NOT win.
      headers: { "Content-type": "text/plain", Authorization: "Bearer attacker-token" },
      consumedParams: [],
      residualParams: [],
    };

    await proxyCall(vault, { site: "demo", resolved });

    const headerObj = capturedHeaders as Record<string, string>;
    // Exactly one content-type key, from callHeaders (call wins over cred).
    expect(Object.keys(headerObj).filter((k) => k.toLowerCase() === "content-type")).toHaveLength(1);
    expect(headerObj["content-type"]).toBe("text/plain");
    // Injected bearer always wins over any callHeaders Authorization.
    expect(Object.keys(headerObj).filter((k) => k.toLowerCase() === "authorization")).toHaveLength(1);
    expect(headerObj.authorization).toBe(`Bearer ${cred.bearer}`);
  });

  test("401 retry excludes the failed bearer so it picks a different credential", async () => {
    const vault = new CredentialVault();
    // Two creds with matching aud hints — tie broken by iat, stale cred wins first.
    // Without wiggle refreshing the stale token, re-pick must fall through to the other cred.
    const staleToken = makeJwt({ aud: "https://stale.example/", iat: 200 });
    const otherToken = makeJwt({ aud: "https://other.example/", iat: 100 });
    vault.noteRequest("demo", authReq("https://stale.example/v1", staleToken));
    vault.noteRequest("demo", authReq("https://other.example/v1", otherToken));

    let call = 0;
    globalThis.fetch = mock(async () => {
      call += 1;
      if (call === 1) return new Response("Unauthorized", { status: 401 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const resolved: ResolvedCall = {
      url: "https://target.example/v1/resource",
      method: "GET",
      headers: {},
      consumedParams: [],
      residualParams: [],
    };

    // Both auds match the hints — stale wins by iat. No wiggle refresh, so stale bearer is excluded
    // on retry and other.example is used instead.
    const result = await proxyCall(vault, {
      site: "demo",
      resolved,
      audHints: ["stale.example", "other.example"],
    });

    expect(result.status).toBe(200);
    expect(result.usedAud).toBe("https://other.example/");
    expect(call).toBe(2);
  });

  test("throws when no credentials exist", async () => {
    const vault = new CredentialVault();
    const resolved: ResolvedCall = {
      url: "https://x.example/v1",
      method: "GET",
      headers: {},
      consumedParams: [],
      residualParams: [],
    };
    await expect(proxyCall(vault, { site: "demo", resolved })).rejects.toThrow(/No credentials available/);
  });
});
