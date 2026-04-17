import { describe, expect, test } from "bun:test";
import type { CapturedRequest } from "./browser/engine";
import { CredentialVault, decodeJwt } from "./credentials";

function makeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.`;
}

function req(url: string, method = "GET", token?: string): CapturedRequest {
  return {
    url,
    method,
    resourceType: "xhr",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    postData: null,
  };
}

describe("decodeJwt", () => {
  test("returns claims for valid payload", () => {
    const token = makeJwt({ aud: "https://foo/", iat: 1 });
    expect(decodeJwt(token)?.aud).toBe("https://foo/");
  });

  test("returns null for garbage", () => {
    expect(decodeJwt("not-a-jwt")).toBeNull();
  });
});

describe("CredentialVault", () => {
  test("noteRequest captures Bearer tokens by aud", () => {
    const v = new CredentialVault();
    const token = makeJwt({ aud: "https://api.example.com/", iat: 100 });
    v.noteRequest("demo", req("https://api.example.com/v1/things", "GET", token));

    const all = v.getAll("demo");
    expect(all).toHaveLength(1);
    expect(all[0].aud).toBe("https://api.example.com/");
  });

  test("ignores non-Bearer auth", () => {
    const v = new CredentialVault();
    v.noteRequest("demo", {
      url: "https://x.example",
      method: "GET",
      resourceType: "xhr",
      headers: { authorization: "Basic abc" },
      postData: null,
    });
    expect(v.getAll("demo")).toHaveLength(0);
  });

  test("keeps fresher bearer on duplicate aud", () => {
    const v = new CredentialVault();
    const older = makeJwt({ aud: "https://api.example.com/", iat: 100 });
    const newer = makeJwt({ aud: "https://api.example.com/", iat: 200 });
    v.noteRequest("demo", req("https://api.example.com/a", "GET", older));
    v.noteRequest("demo", req("https://api.example.com/a", "GET", newer));

    const creds = v.getAll("demo");
    expect(creds).toHaveLength(1);
    expect(creds[0].claims.iat).toBe(200);
    expect(creds[0].observations).toBe(2);
  });

  test("pickCredentialFor prefers matching aud hint", () => {
    const v = new CredentialVault();
    v.noteRequest(
      "demo",
      req("https://api.example.com/a", "GET", makeJwt({ aud: "https://api.example.com/", iat: 1 })),
    );
    v.noteRequest(
      "demo",
      req("https://other.example.com/b", "GET", makeJwt({ aud: "https://other.example.com/", iat: 2 })),
    );

    const pick = v.pickCredentialFor("https://api.example.com/a/b", "GET", ["api.example.com"], "demo");
    expect(pick?.aud).toBe("https://api.example.com/");
  });

  test("pickCredentialFor returns null for empty vault", () => {
    const v = new CredentialVault();
    expect(v.pickCredentialFor("https://x", "GET", [], "demo")).toBeNull();
  });
});
