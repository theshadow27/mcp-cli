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

    // First fetch returns 401. After onWiggle, ensure the vault picks a different aud;
    // we do this by clearing the vault and re-noting only token B so the "fresh" credential differs.
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
      vault.clear("demo");
      vault.noteRequest("demo", authReq("https://b.example/v1", tokenB));
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
