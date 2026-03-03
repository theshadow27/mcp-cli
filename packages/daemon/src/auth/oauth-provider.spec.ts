import { afterEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { KeychainTokens } from "./keychain.js";

// Set up module mock BEFORE importing McpOAuthProvider
const mockReadKeychain = mock<(url: string) => Promise<KeychainTokens | null>>(() => Promise.resolve(null));

mock.module("./keychain.js", () => ({
  readKeychainTokens: (...args: Parameters<typeof mockReadKeychain>) => mockReadKeychain(...args),
}));

// Now import the provider — it will use our mocked keychain
const { McpOAuthProvider } = await import("./oauth-provider.js");
const { StateDb } = await import("../db/state.js");

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

  function createDb(): InstanceType<typeof StateDb> {
    const p = tmpDb();
    paths.push(p);
    return new StateDb(p);
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

      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);
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

      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);
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

      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);
      const tokens = await provider.tokens();

      expect(tokens).toBeUndefined();
      db.close();
    });

    test("omits expires_in for Keychain tokens with no expiresAt", async () => {
      const db = createDb();
      mockReadKeychain.mockImplementation(() => Promise.resolve({ accessToken: "kc-tok", clientId: "kc-client" }));

      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);
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

      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);
      const info = await provider.clientInformation();

      expect(info).toBeDefined();
      expect(info?.client_id).toBe("sqlite-client");
      db.close();
    });

    test("falls back to Keychain client_id", async () => {
      const db = createDb();
      mockReadKeychain.mockImplementation(() => Promise.resolve({ accessToken: "x", clientId: "kc-client-id" }));

      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);
      const info = await provider.clientInformation();

      expect(info).toBeDefined();
      expect(info?.client_id).toBe("kc-client-id");
      db.close();
    });

    test("returns undefined when no client info anywhere", async () => {
      const db = createDb();

      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);
      const info = await provider.clientInformation();

      expect(info).toBeUndefined();
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

      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);
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

      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);
      const result = await provider.discoveryState();

      expect(result).toEqual({ authorizationServerUrl: "https://auth.keychain.com" });
      db.close();
    });

    test("returns undefined when no discovery state anywhere", async () => {
      const db = createDb();

      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);
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

      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);

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

      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);

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

    test("invalidateCredentials('tokens') clears Keychain cache", async () => {
      const db = createDb();
      let callCount = 0;
      mockReadKeychain.mockImplementation(() => {
        callCount++;
        return Promise.resolve({ accessToken: `tok-${callCount}`, clientId: "cid" });
      });

      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);

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
      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);

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
      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);

      provider.saveClientInformation({ client_id: "saved-client" });

      const stored = db.getClientInfo("srv");
      expect(stored).toBeDefined();
      expect(stored?.client_id).toBe("saved-client");
      db.close();
    });

    test("saveDiscoveryState persists to SQLite", async () => {
      const db = createDb();
      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);

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
      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);

      const meta = provider.clientMetadata;
      expect(meta.client_name).toBe("mcp-cli");
      expect(meta.token_endpoint_auth_method).toBe("none");
      expect(meta.grant_types).toContain("authorization_code");
      expect(meta.grant_types).toContain("refresh_token");
      expect(meta.response_types).toContain("code");
      expect(meta.redirect_uris).toEqual(["http://localhost:0/callback"]);
      db.close();
    });

    test("clientMetadata uses setRedirectUrl when set", () => {
      const db = createDb();
      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);
      provider.setRedirectUrl("http://127.0.0.1:12345/callback");

      const meta = provider.clientMetadata;
      expect(meta.redirect_uris).toEqual(["http://127.0.0.1:12345/callback"]);
      db.close();
    });

    test("redirectToAuthorization calls Bun.spawn with open", () => {
      const db = createDb();
      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);

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
        expect(spawnedArgs?.[0]).toBe("open");
        expect(spawnedArgs?.[1]).toBe("https://auth.example.com/authorize?code=abc");
      } finally {
        Bun.spawn = origSpawn;
      }
      db.close();
    });

    test("codeVerifier throws when no verifier saved", () => {
      const db = createDb();
      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);

      expect(() => provider.codeVerifier()).toThrow("No PKCE code verifier");
      db.close();
    });

    test("saveCodeVerifier and codeVerifier round-trip", () => {
      const db = createDb();
      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);

      provider.saveCodeVerifier("my-verifier-123");
      expect(provider.codeVerifier()).toBe("my-verifier-123");
      db.close();
    });

    test("setRedirectUrl updates redirectUrl", () => {
      const db = createDb();
      const provider = new McpOAuthProvider("srv", "https://api.example.com", db);

      expect(provider.redirectUrl).toBeUndefined();
      provider.setRedirectUrl("http://localhost:9999/callback");
      expect(provider.redirectUrl).toBe("http://localhost:9999/callback");
      db.close();
    });
  });
});
