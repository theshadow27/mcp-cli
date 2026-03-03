import { afterEach, describe, expect, test } from "bun:test";

// Dynamic import to avoid mock.module pollution from oauth-provider.spec.ts.
// We re-import each test to get the real (un-mocked) module.
async function importKeychain() {
  const mod = await import(`./keychain.js?t=${Date.now()}`);
  return mod.readKeychainTokens as typeof import("./keychain.js")["readKeychainTokens"];
}

// Save original so we can restore after platform override tests
const originalPlatform = process.platform;

function restorePlatform(): void {
  Object.defineProperty(process, "platform", { value: originalPlatform });
}

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p });
}

/**
 * Mock Bun.spawn for the duration of a callback: replaces the spawned command
 * with `echo <json>` (or any other command) so that readKeychainTokens reads
 * controlled output without touching the real Keychain.
 */
function withSpawnMock<T>(spawnArgs: string[], fn: () => T): T {
  const origSpawn = Bun.spawn;
  (Bun as Record<string, unknown>).spawn = (_cmd: string[], opts: Record<string, unknown>) =>
    origSpawn(spawnArgs, opts);
  try {
    return fn();
  } finally {
    (Bun as Record<string, unknown>).spawn = origSpawn;
  }
}

afterEach(() => {
  restorePlatform();
});

describe("readKeychainTokens", () => {
  test("returns null on non-darwin platforms", async () => {
    setPlatform("linux");
    const readKeychainTokens = await importKeychain();
    expect(await readKeychainTokens("https://api.example.com")).toBeNull();
  });

  test("returns null when security command fails", async () => {
    if (originalPlatform !== "darwin") return;
    const readKeychainTokens = await importKeychain();

    const result = await withSpawnMock(["false"], () => readKeychainTokens("https://api.example.com"));
    expect(result).toBeNull();
  });

  test("returns null when no mcpOAuth entries exist", async () => {
    if (originalPlatform !== "darwin") return;
    const readKeychainTokens = await importKeychain();

    const result = await withSpawnMock(["echo", JSON.stringify({ otherKey: true })], () =>
      readKeychainTokens("https://api.example.com"),
    );
    expect(result).toBeNull();
  });

  test("returns null when no entry matches the target URL", async () => {
    if (originalPlatform !== "darwin") return;
    const readKeychainTokens = await importKeychain();

    const keychainData = {
      mcpOAuth: {
        "server1|abc": {
          serverName: "server1",
          serverUrl: "https://other.example.com",
          accessToken: "tok",
          clientId: "cid",
        },
      },
    };

    const result = await withSpawnMock(["echo", JSON.stringify(keychainData)], () =>
      readKeychainTokens("https://api.example.com"),
    );
    expect(result).toBeNull();
  });

  test("returns tokens when URL matches", async () => {
    if (originalPlatform !== "darwin") return;
    const readKeychainTokens = await importKeychain();

    const keychainData = {
      mcpOAuth: {
        "myserver|xyz": {
          serverName: "myserver",
          serverUrl: "https://api.example.com",
          accessToken: "access-123",
          refreshToken: "refresh-456",
          expiresAt: Date.now() + 3600_000,
          clientId: "client-789",
          scope: "read write",
          discoveryState: {
            authorizationServerUrl: "https://auth.example.com",
          },
        },
      },
    };

    const result = await withSpawnMock(["echo", JSON.stringify(keychainData)], () =>
      readKeychainTokens("https://api.example.com"),
    );
    expect(result).not.toBeNull();
    expect(result?.accessToken).toBe("access-123");
    expect(result?.refreshToken).toBe("refresh-456");
    expect(result?.clientId).toBe("client-789");
    expect(result?.scope).toBe("read write");
    expect(result?.discoveryState).toEqual({
      authorizationServerUrl: "https://auth.example.com",
    });
  });

  test("returns null for expired token without refresh token", async () => {
    if (originalPlatform !== "darwin") return;
    const readKeychainTokens = await importKeychain();

    const keychainData = {
      mcpOAuth: {
        "srv|a": {
          serverName: "srv",
          serverUrl: "https://api.example.com",
          accessToken: "expired-tok",
          expiresAt: Date.now() - 1000,
          clientId: "cid",
        },
      },
    };

    const result = await withSpawnMock(["echo", JSON.stringify(keychainData)], () =>
      readKeychainTokens("https://api.example.com"),
    );
    expect(result).toBeNull();
  });

  test("returns tokens for expired token with refresh token", async () => {
    if (originalPlatform !== "darwin") return;
    const readKeychainTokens = await importKeychain();

    const keychainData = {
      mcpOAuth: {
        "srv|a": {
          serverName: "srv",
          serverUrl: "https://api.example.com",
          accessToken: "expired-tok",
          refreshToken: "refresh-tok",
          expiresAt: Date.now() - 1000,
          clientId: "cid",
        },
      },
    };

    const result = await withSpawnMock(["echo", JSON.stringify(keychainData)], () =>
      readKeychainTokens("https://api.example.com"),
    );
    expect(result).not.toBeNull();
    expect(result?.accessToken).toBe("expired-tok");
    expect(result?.refreshToken).toBe("refresh-tok");
  });

  test("returns null on malformed JSON", async () => {
    if (originalPlatform !== "darwin") return;
    const readKeychainTokens = await importKeychain();

    const result = await withSpawnMock(["echo", "not-valid-json{{{"], () =>
      readKeychainTokens("https://api.example.com"),
    );
    expect(result).toBeNull();
  });
});
