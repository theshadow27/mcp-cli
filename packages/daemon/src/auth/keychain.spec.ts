import { afterEach, describe, expect, test } from "bun:test";
import { readKeychainTokens } from "./keychain";

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
    expect(await readKeychainTokens("https://api.example.com")).toBeNull();
  });

  test("returns null when security command fails", async () => {
    if (originalPlatform !== "darwin") return;
    const result = await withSpawnMock(["false"], () => readKeychainTokens("https://api.example.com"));
    expect(result).toBeNull();
  });

  test("returns null when no mcpOAuth entries exist", async () => {
    if (originalPlatform !== "darwin") return;
    const result = await withSpawnMock(["echo", JSON.stringify({ otherKey: true })], () =>
      readKeychainTokens("https://api.example.com"),
    );
    expect(result).toBeNull();
  });

  test("returns null when no entry matches the target URL", async () => {
    if (originalPlatform !== "darwin") return;
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

  test("returns null for zombie entry (expiresAt=0, empty accessToken, no refreshToken)", async () => {
    if (originalPlatform !== "darwin") return;
    const keychainData = {
      mcpOAuth: {
        "atlassian|1eb778bd626fb68d": {
          serverName: "atlassian",
          serverUrl: "https://mcp.atlassian.com/v1/mcp",
          accessToken: "",
          refreshToken: null,
          expiresAt: 0,
          clientId: "zombie-id",
        },
      },
    };

    const result = await withSpawnMock(["echo", JSON.stringify(keychainData)], () =>
      readKeychainTokens("https://mcp.atlassian.com/v1/mcp"),
    );
    expect(result).toBeNull();
  });

  test("returns null for entry with accessToken but no expiresAt and no refreshToken", async () => {
    if (originalPlatform !== "darwin") return;
    const keychainData = {
      mcpOAuth: {
        "srv|b": {
          serverName: "srv",
          serverUrl: "https://api.example.com",
          accessToken: "some-token",
          expiresAt: 0,
          clientId: "cid",
        },
      },
    };

    const result = await withSpawnMock(["echo", JSON.stringify(keychainData)], () =>
      readKeychainTokens("https://api.example.com"),
    );
    expect(result).toBeNull();
  });

  test("returns null on malformed JSON", async () => {
    if (originalPlatform !== "darwin") return;
    const result = await withSpawnMock(["echo", "not-valid-json{{{"], () =>
      readKeychainTokens("https://api.example.com"),
    );
    expect(result).toBeNull();
  });
});
