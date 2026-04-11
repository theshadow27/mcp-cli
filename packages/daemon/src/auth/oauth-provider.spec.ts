import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { StateDb } from "../db/state";
import type { KeychainTokens } from "./keychain";
import { DEFAULT_OAUTH_SCOPE, McpOAuthProvider, getBrowserCommand } from "./oauth-provider";

const originalPlatform = process.platform;
const originalWslDistro = process.env.WSL_DISTRO_NAME;

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p });
}
function restorePlatform(): void {
  Object.defineProperty(process, "platform", { value: originalPlatform });
}

function tmpDb(): string {
  return join(tmpdir(), `mcp-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // ignore
    }
  }
}

describe("McpOAuthProvider", () => {
  const paths: string[] = [];
  const mockReadKeychain = mock<(url: string) => Promise<KeychainTokens | null>>(() => Promise.resolve(null));

  function createDb(): InstanceType<typeof StateDb> {
    const p = tmpDb();
    paths.push(p);
    return new StateDb(p);
  }

  function createProvider(
    db: InstanceType<typeof StateDb>,
    opts?: { clientId?: string; clientSecret?: string; callbackPort?: number; scope?: string },
  ): InstanceType<typeof McpOAuthProvider> {
    return new McpOAuthProvider("srv", "https://api.example.com", db, {
      ...opts,
      readKeychain: mockReadKeychain,
    });
  }

  afterEach(() => {
    mockReadKeychain.mockReset();
    mockReadKeychain.mockImplementation(() => Promise.resolve(null));
    for (const p of paths) cleanup(p);
    paths.length = 0;
  });

  // -- tokens() --

  describe("tokens()", () => {
    test("returns SQLite tokens when available (priority 1)", async () => {
      const db = createDb();
      const saved: OAuthTokens = {
        access_token: "sqlite-tok",
        token_type: "Bearer",
        refresh_token: "sqlite-refresh",
      };
      db.saveTokens("srv", saved);

      mockReadKeychain.mockImplementation(() =>
        Promise.resolve({ accessToken: "keychain-tok", clientId: "kc-client" }),
      );

      const provider = createProvider(db);
      const tokens = await provider.tokens();

      expect(tokens).toBeDefined();
      expect(tokens?.access_token).toBe("sqlite-tok");
      expect(tokens?.refresh_token).toBe("sqlite-refresh");
      // Keychain should not have been called — SQLite had tokens
      expect(mockReadKeychain).not.toHaveBeenCalled();
      db.close();
    });

    test("falls back to Keychain when SQLite empty (priority 2)", async () => {
      const db = createDb();
      mockReadKeychain.mockImplementation(() =>
        Promise.resolve({
          accessToken: "kc-access",
          refreshToken: "kc-refresh",
          expiresAt: Date.now() + 3600_000,
          clientId: "kc-client",
          scope: "read",
        }),
      );

      const provider = createProvider(db);
      const tokens = await provider.tokens();

      expect(tokens).toBeDefined();
      expect(tokens?.access_token).toBe("kc-access");
      expect(tokens?.token_type).toBe("Bearer");
      expect(tokens?.refresh_token).toBe("kc-refresh");
      expect(tokens?.scope).toBe("read");
      expect(tokens?.expires_in).toBeGreaterThan(0);
      db.close();
    });

    test("returns undefined when both sources empty (priority 3)", async () => {
      const db = createDb();
      // mockReadKeychain already returns null by default

      const provider = createProvider(db);
      const tokens = await provider.tokens();

      expect(tokens).toBeUndefined();
      db.close();
    });

    test("omits expires_in for Keychain tokens with no expiresAt", async () => {
      const db = createDb();
      mockReadKeychain.mockImplementation(() => Promise.resolve({ accessToken: "kc-tok", clientId: "kc-client" }));

      const provider = createProvider(db);
      const tokens = await provider.tokens();

      expect(tokens).toBeDefined();
      expect(tokens?.access_token).toBe("kc-tok");
      expect(tokens?.expires_in).toBeUndefined();
      db.close();
    });
  });

  // -- clientInformation() --

  describe("clientInformation()", () => {
    test("returns SQLite client info when available", async () => {
      const db = createDb();
      db.saveClientInfo("srv", { client_id: "sqlite-client" });
      mockReadKeychain.mockImplementation(() => Promise.resolve({ accessToken: "x", clientId: "kc-client" }));

      const provider = createProvider(db);
      const info = await provider.clientInformation();

      expect(info).toBeDefined();
      expect(info?.client_id).toBe("sqlite-client");
      db.close();
    });

    test("falls back to Keychain client_id", async () => {
      const db = createDb();
      mockReadKeychain.mockImplementation(() => Promise.resolve({ accessToken: "x", clientId: "kc-client-id" }));

      const provider = createProvider(db);
      const info = await provider.clientInformation();

      expect(info).toBeDefined();
      expect(info?.client_id).toBe("kc-client-id");
      db.close();
    });

    test("returns undefined when no client info anywhere", async () => {
      const db = createDb();

      const provider = createProvider(db);
      const info = await provider.clientInformation();

      expect(info).toBeUndefined();
      db.close();
    });

    test("returns config-level clientId/clientSecret before DB or Keychain", async () => {
      const db = createDb();
      // Populate both DB and Keychain with different values
      db.saveClientInfo("srv", { client_id: "sqlite-client" });
      mockReadKeychain.mockImplementation(() => Promise.resolve({ accessToken: "x", clientId: "kc-client" }));

      const provider = createProvider(db, {
        clientId: "config-client",
        clientSecret: "config-secret",
      });
      const info = await provider.clientInformation();

      expect(info).toBeDefined();
      expect(info?.client_id).toBe("config-client");
      expect(info?.client_secret).toBe("config-secret");
      // Neither DB nor Keychain should have been used
      expect(mockReadKeychain).not.toHaveBeenCalled();
      db.close();
    });

    test("returns config-level clientId without secret when only clientId provided", async () => {
      const db = createDb();

      const provider = createProvider(db, {
        clientId: "config-only-id",
      });
      const info = await provider.clientInformation();

      expect(info).toBeDefined();
      expect(info?.client_id).toBe("config-only-id");
      expect(info?.client_secret).toBeUndefined();
      db.close();
    });

    test("exposes callbackPort from opts", () => {
      const db = createDb();
      const provider = createProvider(db, { callbackPort: 9876 });
      expect(provider.callbackPort).toBe(9876);
      db.close();
    });

    test("callbackPort is undefined when not configured", () => {
      const db = createDb();
      const provider = createProvider(db);
      expect(provider.callbackPort).toBeUndefined();
      db.close();
    });
  });

  // -- discoveryState() --

  describe("discoveryState()", () => {
    test("returns SQLite discovery state when available", async () => {
      const db = createDb();
      const state = { authorizationServerUrl: "https://auth.sqlite.com" };
      db.saveDiscoveryState("srv", state);
      mockReadKeychain.mockImplementation(() =>
        Promise.resolve({
          accessToken: "x",
          clientId: "c",
          discoveryState: { authorizationServerUrl: "https://auth.keychain.com" },
        }),
      );

      const provider = createProvider(db);
      const result = await provider.discoveryState();

      expect(result).toEqual({ authorizationServerUrl: "https://auth.sqlite.com" });
      db.close();
    });

    test("falls back to Keychain discovery state", async () => {
      const db = createDb();
      mockReadKeychain.mockImplementation(() =>
        Promise.resolve({
          accessToken: "x",
          clientId: "c",
          discoveryState: { authorizationServerUrl: "https://auth.keychain.com" },
        }),
      );

      const provider = createProvider(db);
      const result = await provider.discoveryState();

      expect(result).toEqual({ authorizationServerUrl: "https://auth.keychain.com" });
      db.close();
    });

    test("returns undefined when no discovery state anywhere", async () => {
      const db = createDb();

      const provider = createProvider(db);
      const result = await provider.discoveryState();

      expect(result).toBeUndefined();
      db.close();
    });
  });

  // -- Keychain caching --

  describe("caching", () => {
    test("reads Keychain only once per provider instance", async () => {
      const db = createDb();
      mockReadKeychain.mockImplementation(() => Promise.resolve({ accessToken: "tok", clientId: "cid" }));

      const provider = createProvider(db);

      // Call multiple methods that trigger Keychain lookup
      await provider.tokens();
      await provider.clientInformation();
      await provider.discoveryState();

      // Keychain should have been read exactly once (cached after first call)
      expect(mockReadKeychain).toHaveBeenCalledTimes(1);
      db.close();
    });

    test("invalidateCredentials('all') clears Keychain cache", async () => {
      const db = createDb();
      let callCount = 0;
      mockReadKeychain.mockImplementation(() => {
        callCount++;
        return Promise.resolve({ accessToken: `tok-${callCount}`, clientId: "cid" });
      });

      const provider = createProvider(db);

      // First call caches
      const first = await provider.tokens();
      expect(first?.access_token).toBe("tok-1");

      // Invalidate clears the cache
      provider.invalidateCredentials("all");

      // Second call re-reads Keychain
      const second = await provider.tokens();
      expect(second?.access_token).toBe("tok-2");
      expect(callCount).toBe(2);
      db.close();
    });

    test("invalidateCredentials('all') also deletes SQLite tokens", async () => {
      const db = createDb();
      const provider = createProvider(db);

      db.saveTokens("srv", { access_token: "to-delete", token_type: "Bearer" });
      expect(db.getTokens("srv")).toBeDefined();

      provider.invalidateCredentials("all");

      expect(db.getTokens("srv")).toBeUndefined();
      db.close();
    });

    test("invalidateCredentials('client') does not affect tokens or verifier", () => {
      const db = createDb();
      const provider = createProvider(db);

      db.saveTokens("srv", { access_token: "tok", token_type: "Bearer" });
      db.saveVerifier("srv", "pkce-123");

      provider.invalidateCredentials("client");

      expect(db.getTokens("srv")?.access_token).toBe("tok");
      expect(db.getVerifier("srv")).toBe("pkce-123");
      db.close();
    });

    test("invalidateCredentials('verifier') does not affect tokens", () => {
      const db = createDb();
      const provider = createProvider(db);

      db.saveTokens("srv", { access_token: "tok", token_type: "Bearer" });

      provider.invalidateCredentials("verifier");

      expect(db.getTokens("srv")?.access_token).toBe("tok");
      db.close();
    });

    test("invalidateCredentials('discovery') does not affect tokens", () => {
      const db = createDb();
      const provider = createProvider(db);

      db.saveTokens("srv", { access_token: "tok", token_type: "Bearer" });
      db.saveDiscoveryState("srv", { authorizationServerUrl: "https://auth.example.com" });

      provider.invalidateCredentials("discovery");

      expect(db.getTokens("srv")?.access_token).toBe("tok");
      db.close();
    });

    test("invalidateCredentials('tokens') clears Keychain cache", async () => {
      const db = createDb();
      let callCount = 0;
      mockReadKeychain.mockImplementation(() => {
        callCount++;
        return Promise.resolve({ accessToken: `tok-${callCount}`, clientId: "cid" });
      });

      const provider = createProvider(db);

      await provider.tokens();
      provider.invalidateCredentials("tokens");
      await provider.tokens();

      expect(callCount).toBe(2);
      db.close();
    });
  });

  // -- Write methods go to SQLite --

  describe("writes go to SQLite", () => {
    test("saveTokens persists to SQLite", () => {
      const db = createDb();
      const provider = createProvider(db);

      provider.saveTokens({
        access_token: "saved-tok",
        token_type: "Bearer",
      });

      const stored = db.getTokens("srv");
      expect(stored).toBeDefined();
      expect(stored?.access_token).toBe("saved-tok");
      db.close();
    });

    test("saveClientInformation persists to SQLite", () => {
      const db = createDb();
      const provider = createProvider(db);

      provider.saveClientInformation({ client_id: "saved-client" });

      const stored = db.getClientInfo("srv");
      expect(stored).toBeDefined();
      expect(stored?.client_id).toBe("saved-client");
      db.close();
    });

    test("saveDiscoveryState persists to SQLite", async () => {
      const db = createDb();
      const provider = createProvider(db);

      await provider.saveDiscoveryState({
        authorizationServerUrl: "https://auth.example.com",
      });

      const stored = db.getDiscoveryState("srv");
      expect(stored).toEqual({ authorizationServerUrl: "https://auth.example.com" });
      db.close();
    });
  });

  // -- Other provider behavior --

  describe("other behavior", () => {
    test("clientMetadata returns correct defaults without redirect URL", () => {
      const db = createDb();
      const provider = createProvider(db);

      const meta = provider.clientMetadata;
      expect(meta.client_name).toBe("mcp-cli");
      expect(meta.token_endpoint_auth_method).toBe("none");
      expect(meta.grant_types).toContain("authorization_code");
      expect(meta.grant_types).toContain("refresh_token");
      expect(meta.response_types).toContain("code");
      expect(meta.redirect_uris).toEqual(["http://localhost/callback"]);
      // No hardcoded scope — avoids breaking non-OIDC servers on registration/token exchange
      expect(meta.scope).toBeUndefined();
      db.close();
    });

    test("clientMetadata includes scope only when explicitly configured", () => {
      const db = createDb();
      const provider = createProvider(db, { scope: "read write" });

      const meta = provider.clientMetadata;
      expect(meta.scope).toBe("read write");
      db.close();
    });

    test("clientMetadata excludes whitespace-only scope", () => {
      const db = createDb();
      const provider = createProvider(db, { scope: "  " });

      const meta = provider.clientMetadata;
      expect(meta.scope).toBeUndefined();
      db.close();
    });

    test("clientMetadata uses setRedirectUrl when set", () => {
      const db = createDb();
      const provider = createProvider(db);
      provider.setRedirectUrl("http://127.0.0.1:12345/callback");

      const meta = provider.clientMetadata;
      expect(meta.redirect_uris).toEqual(["http://127.0.0.1:12345/callback"]);
      db.close();
    });

    test("redirectToAuthorization suppresses browser when setRedirectUrl not called", () => {
      // In connection phase (server-pool.ts), setRedirectUrl is never called.
      // redirectToAuthorization must NOT open a browser — just log the re-auth message.
      const db = createDb();
      const provider = createProvider(db);

      // Should return without throwing and without calling Bun.spawn.
      // (If Bun.spawn were called it would try to exec a real browser command in CI.)
      expect(() => {
        provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?code=abc"));
      }).not.toThrow();
      db.close();
    });

    test("redirectToAuthorization opens browser when setRedirectUrl was called", () => {
      const db = createDb();
      const provider = createProvider(db);
      provider.setRedirectUrl("http://localhost:9999/callback");

      const origSpawn = Bun.spawn;
      let spawnedArgs: string[] | undefined;
      // @ts-expect-error — overriding Bun.spawn for test
      Bun.spawn = (args: string[]) => {
        spawnedArgs = args;
        return origSpawn(["true"], { stdout: "ignore", stderr: "ignore" });
      };

      try {
        provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?code=abc"));
        expect(spawnedArgs).toBeDefined();
        // The exact command depends on platform; just verify the URL is included
        expect(spawnedArgs).toContain("https://auth.example.com/authorize?code=abc");
      } finally {
        Bun.spawn = origSpawn;
      }
      db.close();
    });

    test("codeVerifier throws when no verifier saved", () => {
      const db = createDb();
      const provider = createProvider(db);

      expect(() => provider.codeVerifier()).toThrow("No PKCE code verifier");
      db.close();
    });

    test("saveCodeVerifier and codeVerifier round-trip", () => {
      const db = createDb();
      const provider = createProvider(db);

      provider.saveCodeVerifier("my-verifier-123");
      expect(provider.codeVerifier()).toBe("my-verifier-123");
      db.close();
    });

    test("redirectUrl returns default before setRedirectUrl (SDK 1.27.1 nonInteractiveFlow guard)", () => {
      // SDK 1.27.1 added: nonInteractiveFlow = !provider.redirectUrl
      // If redirectUrl is undefined the SDK skips refresh_token and calls fetchToken()
      // which fails without prepareTokenRequest(). The default ensures the SDK uses
      // the interactive path (authorization_code + refresh_token flow).
      const db = createDb();
      const provider = createProvider(db);

      expect(provider.redirectUrl).toBe("http://localhost/callback");
      db.close();
    });

    test("setRedirectUrl overrides the default redirectUrl", () => {
      const db = createDb();
      const provider = createProvider(db);

      provider.setRedirectUrl("http://localhost:9999/callback");
      expect(provider.redirectUrl).toBe("http://localhost:9999/callback");
      db.close();
    });
  });

  // -- validateResourceURL() --

  describe("validateResourceURL()", () => {
    test("returns resource URL when same origin with different path", async () => {
      const db = createDb();
      const provider = createProvider(db);

      const result = await provider.validateResourceURL("https://api.example.com/sse", "https://api.example.com/v2");

      expect(result).toEqual(new URL("https://api.example.com/v2"));
      db.close();
    });

    test("returns resource URL when paths match", async () => {
      const db = createDb();
      const provider = createProvider(db);

      const result = await provider.validateResourceURL("https://api.example.com/api", "https://api.example.com/api");

      expect(result).toEqual(new URL("https://api.example.com/api"));
      db.close();
    });

    test("returns undefined when no resource provided", async () => {
      const db = createDb();
      const provider = createProvider(db);

      const result = await provider.validateResourceURL("https://api.example.com/sse");

      expect(result).toBeUndefined();
      db.close();
    });

    test("throws when origins differ", async () => {
      const db = createDb();
      const provider = createProvider(db);

      await expect(
        provider.validateResourceURL("https://api.example.com/sse", "https://evil.example.com/v2"),
      ).rejects.toThrow("origin does not match");
      db.close();
    });

    test("throws when schemes differ", async () => {
      const db = createDb();
      const provider = createProvider(db);

      await expect(
        provider.validateResourceURL("https://api.example.com/sse", "http://api.example.com/v2"),
      ).rejects.toThrow("origin does not match");
      db.close();
    });

    test("accepts URL objects as serverUrl", async () => {
      const db = createDb();
      const provider = createProvider(db);

      const result = await provider.validateResourceURL(
        new URL("https://api.example.com/sse"),
        "https://api.example.com/v2",
      );

      expect(result).toEqual(new URL("https://api.example.com/v2"));
      db.close();
    });
  });

  // -- getEffectiveScope() --

  describe("getEffectiveScope()", () => {
    test("returns config scope when explicitly set", () => {
      const db = createDb();
      const provider = createProvider(db, { scope: "read write admin" });

      expect(provider.getEffectiveScope()).toBe("read write admin");
      db.close();
    });

    test("returns undefined when no config scope (lets SDK cascade handle it)", () => {
      const db = createDb();
      const provider = createProvider(db);

      expect(provider.getEffectiveScope()).toBeUndefined();
      db.close();
    });

    test("returns undefined when config scope is empty/whitespace", () => {
      const db = createDb();
      const provider = createProvider(db, { scope: "  " });

      expect(provider.getEffectiveScope()).toBeUndefined();
      db.close();
    });

    test("DEFAULT_OAUTH_SCOPE is the OIDC fallback used when getEffectiveScope() returns undefined", () => {
      // This constant is the fallback applied at the ipc-server.ts call-site:
      //   provider.getEffectiveScope() ?? DEFAULT_OAUTH_SCOPE
      // It ensures Atlassian-style providers (which require scope=openid email profile
      // but don't publish scopes_supported in resource metadata) get a scope on the auth URL.
      expect(DEFAULT_OAUTH_SCOPE).toBe("openid email profile");
    });
  });
});

describe("getBrowserCommand", () => {
  afterEach(() => {
    restorePlatform();
    if (originalWslDistro === undefined) {
      process.env.WSL_DISTRO_NAME = "";
    } else {
      process.env.WSL_DISTRO_NAME = originalWslDistro;
    }
  });

  test("returns 'open' on macOS", () => {
    setPlatform("darwin");
    expect(getBrowserCommand("https://example.com")).toEqual(["open", "https://example.com"]);
  });

  test("returns 'xdg-open' on Linux", () => {
    setPlatform("linux");
    process.env.WSL_DISTRO_NAME = "";
    expect(getBrowserCommand("https://example.com")).toEqual(["xdg-open", "https://example.com"]);
  });

  test("returns 'wslview' on WSL", () => {
    setPlatform("linux");
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    expect(getBrowserCommand("https://example.com")).toEqual(["wslview", "https://example.com"]);
  });

  test("returns 'cmd.exe' on Windows", () => {
    setPlatform("win32");
    expect(getBrowserCommand("https://example.com")).toEqual(["cmd.exe", "/c", "start", "", "https://example.com"]);
  });
});
