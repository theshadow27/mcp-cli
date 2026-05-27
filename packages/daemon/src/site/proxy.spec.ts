import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BrowserEngine, CapturedRequest, FetchInPageResult } from "./browser/engine";
import { CredentialVault } from "./credentials";
import { cookieProxyCall, proxyCall } from "./proxy";
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

function fakeBrowserEngine(impl?: {
  fetchInPage?: BrowserEngine["fetchInPage"];
}): BrowserEngine {
  return {
    start: async () => [],
    stop: async () => {},
    isRunning: () => true,
    getSiteNames: () => ["demo"],
    coldStart: async () => ({ cleared: [], reloaded: true }),
    wiggle: async () => [],
    evalInPage: async () => null,
    fetchInPage: impl?.fetchInPage ?? (async () => ({ status: 200, headers: {}, body: {} })),
    getUrl: async () => "https://demo.example",
    getTitle: async () => "Demo",
    getHtml: async () => "<html></html>",
  };
}

describe("cookieProxyCall", () => {
  test("routes fetch through browser and returns result with usedAud '(cookie)'", async () => {
    let capturedUrl = "";
    let capturedBody: string | undefined;
    const browser = fakeBrowserEngine({
      fetchInPage: async (url, _method, _headers, body, _site) => {
        capturedUrl = url;
        capturedBody = body;
        return { status: 200, headers: { "content-type": "application/json" }, body: { items: [1, 2] } };
      },
    });

    const resolved: ResolvedCall = {
      url: "https://intranet.example/api/data",
      method: "POST",
      body: '{"query":"test"}',
      headers: { "content-type": "application/json" },
      consumedParams: [],
      residualParams: [],
    };

    const result = await cookieProxyCall({ site: "demo", resolved, browser });

    expect(result.status).toBe(200);
    expect(result.usedAud).toBe("(cookie)");
    expect(result.body).toEqual({ items: [1, 2] });
    expect(result.url).toBe("https://intranet.example/api/data");
    expect(result.method).toBe("POST");
    expect(capturedUrl).toBe("https://intranet.example/api/data");
    expect(capturedBody).toBe('{"query":"test"}');
  });

  test("strips authorization header before sending to browser", async () => {
    let capturedHeaders: Record<string, string> = {};
    const browser = fakeBrowserEngine({
      fetchInPage: async (_url, _method, headers) => {
        capturedHeaders = headers;
        return { status: 200, headers: {}, body: {} };
      },
    });

    const resolved: ResolvedCall = {
      url: "https://intranet.example/api",
      method: "GET",
      headers: { authorization: "Bearer stale-token", "x-custom": "keep-this" },
      consumedParams: [],
      residualParams: [],
    };

    await cookieProxyCall({ site: "demo", resolved, browser });

    expect(capturedHeaders.authorization).toBeUndefined();
    expect(capturedHeaders["x-custom"]).toBe("keep-this");
  });

  test("wraps browser errors with diagnostic message", async () => {
    const browser = fakeBrowserEngine({
      fetchInPage: async () => {
        throw new Error("Target closed");
      },
    });

    const resolved: ResolvedCall = {
      url: "https://intranet.example/api",
      method: "GET",
      headers: {},
      consumedParams: [],
      residualParams: [],
    };

    await expect(cookieProxyCall({ site: "demo", resolved, browser })).rejects.toThrow(
      /Cookie-mode fetch failed.*Target closed/,
    );
  });

  test("passes site name to browser fetchInPage for correct page selection", async () => {
    let capturedSite: string | undefined;
    const browser = fakeBrowserEngine({
      fetchInPage: async (_url, _method, _headers, _body, site) => {
        capturedSite = site;
        return { status: 200, headers: {}, body: {} };
      },
    });

    const resolved: ResolvedCall = {
      url: "https://intranet.example/api",
      method: "GET",
      headers: {},
      consumedParams: [],
      residualParams: [],
    };

    await cookieProxyCall({ site: "mysite", resolved, browser });
    expect(capturedSite).toBe("mysite");
  });
});
