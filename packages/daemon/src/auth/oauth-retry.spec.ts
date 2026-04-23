import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StateDb } from "../db/state";
import type { CallbackServer } from "./callback-server";
import { runOAuthFlowWithDcrRetry } from "./oauth-retry";

function tmpDb(): string {
  return join(tmpdir(), `mcp-cli-retry-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

function makeCallback(waitForCode: Promise<string>): CallbackServer {
  return {
    url: "http://localhost:9999/callback",
    port: 9999,
    waitForCode,
    stop: () => {},
  };
}

const SERVER = "test-srv";
const SERVER_URL = "https://api.example.com";

describe("runOAuthFlowWithDcrRetry", () => {
  const dbPaths: string[] = [];

  function createDb(): StateDb {
    const p = tmpDb();
    dbPaths.push(p);
    return new StateDb(p);
  }

  afterEach(() => {
    for (const p of dbPaths) cleanup(p);
    dbPaths.length = 0;
  });

  // -- Happy path --

  test("returns 'authenticated' on first attempt when code received", async () => {
    const db = createDb();
    let authCallCount = 0;

    const result = await runOAuthFlowWithDcrRetry(
      SERVER,
      SERVER_URL,
      db,
      {},
      {
        authFn: async (_provider, opts) => {
          authCallCount++;
          if (opts.authorizationCode) return "AUTHORIZED";
          return "REDIRECT";
        },
        startCallbackServer: () => makeCallback(Promise.resolve("code-abc")),
      },
    );

    expect(result).toBe("authenticated");
    // Two auth calls: REDIRECT phase + code exchange
    expect(authCallCount).toBe(2);
    db.close();
  });

  test("returns 'already_authorized' when provider tokens are valid", async () => {
    const db = createDb();
    let authCallCount = 0;
    let callbackCreated = false;

    const result = await runOAuthFlowWithDcrRetry(
      SERVER,
      SERVER_URL,
      db,
      {},
      {
        authFn: async () => {
          authCallCount++;
          return "AUTHORIZED";
        },
        startCallbackServer: () => {
          callbackCreated = true;
          // Promise is never awaited in the AUTHORIZED path — use a pending promise
          return makeCallback(new Promise<string>(() => {}));
        },
      },
    );

    expect(result).toBe("already_authorized");
    // Only one auth call — no code exchange needed
    expect(authCallCount).toBe(1);
    // Callback server was created (needed for redirect URL), but waitForCode never awaited
    expect(callbackCreated).toBe(true);
    db.close();
  });

  // -- Retry behavior --

  test("retries after callback timeout, deletes client info, succeeds on second attempt", async () => {
    const db = createDb();
    db.saveClientInfo(SERVER, { client_id: "burned-client-A" });

    let callbackNum = 0;
    let authCallCount = 0;
    const deletedClientsBetweenAttempts: string[] = [];

    const result = await runOAuthFlowWithDcrRetry(
      SERVER,
      SERVER_URL,
      db,
      {},
      {
        authFn: async (_provider, opts) => {
          authCallCount++;
          if (opts.authorizationCode) return "AUTHORIZED";
          // Capture db state at each REDIRECT call
          const info = db.getClientInfo(SERVER);
          if (info) deletedClientsBetweenAttempts.push(info.client_id);
          return "REDIRECT";
        },
        startCallbackServer: () => {
          callbackNum++;
          if (callbackNum === 1) {
            // First attempt: callback times out (authorize endpoint returned 5xx)
            return makeCallback(Promise.reject(new Error("OAuth callback timeout (2 minutes)")));
          }
          // Second attempt: user completes consent
          return makeCallback(Promise.resolve("code-fresh"));
        },
      },
    );

    expect(result).toBe("authenticated");
    // First REDIRECT (timeout), Second REDIRECT, code exchange = 3 calls
    expect(authCallCount).toBe(3);
    // Client info was present on first attempt, deleted before second
    expect(deletedClientsBetweenAttempts).toEqual(["burned-client-A"]);
    // After retry the old client info is gone (new one would be saved by real SDK)
    expect(db.getClientInfo(SERVER)).toBeUndefined();
    db.close();
  });

  test("fails with clear message after two consecutive timeouts (no infinite loop)", async () => {
    const db = createDb();
    let callbackNum = 0;

    await expect(
      runOAuthFlowWithDcrRetry(
        SERVER,
        SERVER_URL,
        db,
        {},
        {
          authFn: async () => "REDIRECT",
          startCallbackServer: () => {
            callbackNum++;
            return makeCallback(Promise.reject(new Error("OAuth callback timeout (2 minutes)")));
          },
        },
      ),
    ).rejects.toThrow("no recovery available");

    // Exactly two callback servers created: initial attempt + one retry
    expect(callbackNum).toBe(2);
    db.close();
  });

  test("does not retry on non-timeout errors (e.g. OAuth error parameter)", async () => {
    const db = createDb();
    let callbackNum = 0;

    await expect(
      runOAuthFlowWithDcrRetry(
        SERVER,
        SERVER_URL,
        db,
        {},
        {
          authFn: async () => "REDIRECT",
          startCallbackServer: () => {
            callbackNum++;
            return makeCallback(Promise.reject(new Error("OAuth error: access_denied")));
          },
        },
      ),
    ).rejects.toThrow("OAuth error: access_denied");

    // Only one attempt — access_denied is not a 5xx
    expect(callbackNum).toBe(1);
    db.close();
  });

  test("regression: happy path makes exactly two auth calls, no client info deleted", async () => {
    const db = createDb();
    db.saveClientInfo(SERVER, { client_id: "live-client" });

    let authCallCount = 0;

    await runOAuthFlowWithDcrRetry(
      SERVER,
      SERVER_URL,
      db,
      {},
      {
        authFn: async (_provider, opts) => {
          authCallCount++;
          if (opts.authorizationCode) return "AUTHORIZED";
          return "REDIRECT";
        },
        startCallbackServer: () => makeCallback(Promise.resolve("code-xyz")),
      },
    );

    // No extra DCR churn
    expect(authCallCount).toBe(2);
    // Client info untouched
    expect(db.getClientInfo(SERVER)?.client_id).toBe("live-client");
    db.close();
  });
});

// -- StateDb.deleteClientInfo --

describe("StateDb.deleteClientInfo", () => {
  const dbPaths: string[] = [];

  function createDb(): StateDb {
    const p = tmpDb();
    dbPaths.push(p);
    return new StateDb(p);
  }

  afterEach(() => {
    for (const p of dbPaths) cleanup(p);
    dbPaths.length = 0;
  });

  test("removes client info row", () => {
    const db = createDb();
    db.saveClientInfo("srv", { client_id: "to-delete" });
    expect(db.getClientInfo("srv")).toBeDefined();

    db.deleteClientInfo("srv");

    expect(db.getClientInfo("srv")).toBeUndefined();
    db.close();
  });

  test("no-ops when row does not exist", () => {
    const db = createDb();
    // Should not throw
    expect(() => db.deleteClientInfo("nonexistent")).not.toThrow();
    db.close();
  });

  test("only deletes the targeted server", () => {
    const db = createDb();
    db.saveClientInfo("srv-a", { client_id: "a" });
    db.saveClientInfo("srv-b", { client_id: "b" });

    db.deleteClientInfo("srv-a");

    expect(db.getClientInfo("srv-a")).toBeUndefined();
    expect(db.getClientInfo("srv-b")?.client_id).toBe("b");
    db.close();
  });
});
