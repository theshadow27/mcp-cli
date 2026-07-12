import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { StateDb } from "../db/state";
import { metrics } from "../metrics";
import { OAuthCallbackTimeoutError } from "./callback-server";
import type { CallbackServer } from "./callback-server";
import type { KeychainTokens } from "./keychain";
import { AuthFlowInProgressError, _resetActiveAuthFlows, runOAuthFlowWithDcrRetry } from "./oauth-retry";

function tmpDb(): string {
  return join(tmpdir(), `mcp-cli-retry-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
      // dotw-ignore test-empty-catch: best-effort cleanup — resource may already be gone
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
        authFn: async (_provider, authOpts) => {
          authCallCount++;
          if (authOpts.authorizationCode) return "AUTHORIZED";
          // Capture db state at each REDIRECT call
          const info = db.getClientInfo(SERVER);
          if (info) deletedClientsBetweenAttempts.push(info.client_id);
          return "REDIRECT";
        },
        startCallbackServer: () => {
          callbackNum++;
          if (callbackNum === 1) {
            // First attempt: no callback received within the timeout window
            return makeCallback(Promise.reject(new OAuthCallbackTimeoutError()));
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

  test("skips keychain client_id on retry so burned keychain entry does not restore zombie", async () => {
    const db = createDb();
    // No SQLite entry — keychain holds the only (burned) client_id
    const keychainClientId = "burned-keychain-client";
    const seenClientIds: Array<string | undefined> = [];

    let callbackNum = 0;
    await runOAuthFlowWithDcrRetry(
      SERVER,
      SERVER_URL,
      db,
      {
        readKeychain: async (): Promise<KeychainTokens | null> =>
          Promise.resolve({ accessToken: "tok", expiresAt: Date.now() + 3600_000, clientId: keychainClientId }),
      },
      {
        authFn: async (provider, authOpts) => {
          if (authOpts.authorizationCode) return "AUTHORIZED";
          // Capture what clientInformation() returns for this attempt
          const info = await (
            provider as { clientInformation(): Promise<{ client_id?: string } | undefined> }
          ).clientInformation();
          seenClientIds.push(info?.client_id);
          return "REDIRECT";
        },
        startCallbackServer: () => {
          callbackNum++;
          if (callbackNum === 1) {
            return makeCallback(Promise.reject(new OAuthCallbackTimeoutError()));
          }
          return makeCallback(Promise.resolve("code-fresh"));
        },
      },
    );

    // First attempt sees keychain client_id; second attempt skips it → undefined → fresh DCR
    expect(seenClientIds[0]).toBe(keychainClientId);
    expect(seenClientIds[1]).toBeUndefined();
    db.close();
  });

  test("increments oauth_dcr_retry_total{outcome=success} metric on successful retry", async () => {
    const db = createDb();
    let callbackNum = 0;

    const beforeSnap = metrics.toJSON();
    const before =
      beforeSnap.counters.find((c) => c.name === "oauth_dcr_retry_total" && c.labels?.outcome === "success")?.value ??
      0;

    await runOAuthFlowWithDcrRetry(
      SERVER,
      SERVER_URL,
      db,
      {},
      {
        authFn: async (_provider, authOpts) => {
          if (authOpts.authorizationCode) return "AUTHORIZED";
          return "REDIRECT";
        },
        startCallbackServer: () => {
          callbackNum++;
          if (callbackNum === 1) return makeCallback(Promise.reject(new OAuthCallbackTimeoutError()));
          return makeCallback(Promise.resolve("code-x"));
        },
      },
    );

    const afterSnap = metrics.toJSON();
    const after =
      afterSnap.counters.find((c) => c.name === "oauth_dcr_retry_total" && c.labels?.outcome === "success")?.value ?? 0;
    expect(after - before).toBe(1);
    db.close();
  });

  test("increments oauth_dcr_retry_total{outcome=double_timeout} metric on double failure", async () => {
    const db = createDb();

    const beforeSnap = metrics.toJSON();
    const before =
      beforeSnap.counters.find((c) => c.name === "oauth_dcr_retry_total" && c.labels?.outcome === "double_timeout")
        ?.value ?? 0;

    await expect(
      runOAuthFlowWithDcrRetry(
        SERVER,
        SERVER_URL,
        db,
        {},
        {
          authFn: async () => "REDIRECT",
          startCallbackServer: () => makeCallback(Promise.reject(new OAuthCallbackTimeoutError())),
        },
      ),
    ).rejects.toThrow();

    const afterSnap = metrics.toJSON();
    const after =
      afterSnap.counters.find((c) => c.name === "oauth_dcr_retry_total" && c.labels?.outcome === "double_timeout")
        ?.value ?? 0;
    expect(after - before).toBe(1);
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
            return makeCallback(Promise.reject(new OAuthCallbackTimeoutError()));
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

    // Only one attempt — access_denied is not a timeout, no retry
    expect(callbackNum).toBe(1);
    db.close();
  });

  // -- invalid_grant (revoked/rotated refresh token) recovery (#2840) --

  test("recovers from invalid_grant by retrying via browser (fresh authorization_code flow)", async () => {
    const db = createDb();
    const seenRefreshTokens: Array<string | undefined> = [];
    let redirectCalls = 0;

    const result = await runOAuthFlowWithDcrRetry(
      SERVER,
      SERVER_URL,
      db,
      {
        // Keychain holds a refresh token that the server has revoked.
        readKeychain: async (): Promise<KeychainTokens> =>
          Promise.resolve({ accessToken: "kc-tok", refreshToken: "kc-revoked-refresh", clientId: "kc-client" }),
      },
      {
        authFn: async (provider, authOpts) => {
          if (authOpts.authorizationCode) return "AUTHORIZED";
          redirectCalls++;
          const toks = await (provider as { tokens(): Promise<{ refresh_token?: string } | undefined> }).tokens();
          seenRefreshTokens.push(toks?.refresh_token);
          // First attempt: SDK refresh throws invalid_grant. Retry: no token.
          if (redirectCalls === 1) {
            throw new InvalidGrantError("The refresh_token provided was invalid.");
          }
          return "REDIRECT";
        },
        startCallbackServer: () => makeCallback(Promise.resolve("code-fresh")),
      },
    );

    expect(result).toBe("authenticated");
    // First attempt sees the revoked keychain refresh token; retry skips the
    // keychain fallback so no stale token is re-served (would loop otherwise).
    expect(seenRefreshTokens).toEqual(["kc-revoked-refresh", undefined]);
    db.close();
  });

  test("invalid_grant retry deletes SQLite tokens before the fresh flow", async () => {
    const db = createDb();
    db.saveTokens(SERVER, { access_token: "stale", token_type: "Bearer", refresh_token: "stale-refresh" });

    let redirectCalls = 0;
    await runOAuthFlowWithDcrRetry(
      SERVER,
      SERVER_URL,
      db,
      {},
      {
        authFn: async (_provider, authOpts) => {
          if (authOpts.authorizationCode) return "AUTHORIZED";
          redirectCalls++;
          if (redirectCalls === 1) throw new InvalidGrantError("invalid refresh");
          return "REDIRECT";
        },
        startCallbackServer: () => makeCallback(Promise.resolve("code-fresh")),
      },
    );

    // Stale SQLite token was invalidated on the retry path
    expect(db.getTokens(SERVER)).toBeUndefined();
    db.close();
  });

  test("does not loop forever on repeated invalid_grant — rethrows after one retry", async () => {
    const db = createDb();
    let callbackNum = 0;

    await expect(
      runOAuthFlowWithDcrRetry(
        SERVER,
        SERVER_URL,
        db,
        {},
        {
          authFn: async (_provider, authOpts) => {
            if (authOpts.authorizationCode) return "AUTHORIZED";
            throw new InvalidGrantError("still invalid");
          },
          startCallbackServer: () => {
            callbackNum++;
            return makeCallback(Promise.resolve("code"));
          },
        },
      ),
    ).rejects.toThrow("still invalid");

    // Exactly two attempts: initial + one retry
    expect(callbackNum).toBe(2);
    db.close();
  });

  test("increments oauth_refresh_retry_total{triggered,success} on invalid_grant recovery", async () => {
    const db = createDb();
    let redirectCalls = 0;

    const snap = (outcome: string): number =>
      metrics.toJSON().counters.find((c) => c.name === "oauth_refresh_retry_total" && c.labels?.outcome === outcome)
        ?.value ?? 0;

    const triggeredBefore = snap("triggered");
    const successBefore = snap("success");

    await runOAuthFlowWithDcrRetry(
      SERVER,
      SERVER_URL,
      db,
      {},
      {
        authFn: async (_provider, authOpts) => {
          if (authOpts.authorizationCode) return "AUTHORIZED";
          redirectCalls++;
          if (redirectCalls === 1) throw new InvalidGrantError("invalid");
          return "REDIRECT";
        },
        startCallbackServer: () => makeCallback(Promise.resolve("code-x")),
      },
    );

    expect(snap("triggered") - triggeredBefore).toBe(1);
    expect(snap("success") - successBefore).toBe(1);
    db.close();
  });

  test("skipKeychainTokens opt bypasses the keychain token on the first attempt (--force plumbing)", async () => {
    const db = createDb();
    const seenRefreshTokens: Array<string | undefined> = [];
    let redirectCalls = 0;

    // --force threads skipKeychainTokens:true. A keychain token is present but
    // must NEVER be served — the flow goes straight to a fresh browser auth with
    // no invalid_grant round-trip (that round-trip is what --force must avoid).
    const result = await runOAuthFlowWithDcrRetry(
      SERVER,
      SERVER_URL,
      db,
      {
        skipKeychainTokens: true,
        readKeychain: async (): Promise<KeychainTokens> =>
          Promise.resolve({ accessToken: "kc-tok", refreshToken: "kc-revoked-refresh", clientId: "kc-client" }),
      },
      {
        authFn: async (provider, authOpts) => {
          if (authOpts.authorizationCode) return "AUTHORIZED";
          redirectCalls++;
          const toks = await (provider as { tokens(): Promise<{ refresh_token?: string } | undefined> }).tokens();
          seenRefreshTokens.push(toks?.refresh_token);
          return "REDIRECT";
        },
        startCallbackServer: () => makeCallback(Promise.resolve("code-fresh")),
      },
    );

    expect(result).toBe("authenticated");
    // Exactly one redirect (no invalid_grant retry) and the keychain refresh
    // token was never surfaced — skipped from the very first attempt.
    expect(redirectCalls).toBe(1);
    expect(seenRefreshTokens).toEqual([undefined]);
    db.close();
  });

  test("recovers from a DCR timeout AND a subsequent invalid_grant in one flow (independent budgets)", async () => {
    const db = createDb();
    let callbackNum = 0;
    let redirectCalls = 0;

    // Server burns client_ids (DCR timeout) and holds a revoked refresh token.
    // Both recoveries must fire in a single flow — a shared retry budget would
    // let the DCR retry starve the invalid_grant retry (or vice versa).
    const result = await runOAuthFlowWithDcrRetry(
      SERVER,
      SERVER_URL,
      db,
      {},
      {
        authFn: async (_provider, authOpts) => {
          if (authOpts.authorizationCode) return "AUTHORIZED";
          redirectCalls++;
          // After the DCR retry, the second attempt hits the revoked token.
          if (redirectCalls === 2) throw new InvalidGrantError("revoked");
          return "REDIRECT";
        },
        startCallbackServer: () => {
          callbackNum++;
          // First attempt times out → burns client_id → DCR retry.
          if (callbackNum === 1) return makeCallback(Promise.reject(new OAuthCallbackTimeoutError()));
          return makeCallback(Promise.resolve("code-fresh"));
        },
      },
    );

    expect(result).toBe("authenticated");
    // initial (timeout) + DCR retry (invalid_grant) + invalid_grant retry = 3
    expect(callbackNum).toBe(3);
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

// -- Per-server concurrency guard (#1624) --

describe("per-server auth concurrency guard", () => {
  const dbPaths: string[] = [];

  function createDb(): StateDb {
    const p = tmpDb();
    dbPaths.push(p);
    return new StateDb(p);
  }

  afterEach(() => {
    _resetActiveAuthFlows();
    for (const p of dbPaths) cleanup(p);
    dbPaths.length = 0;
  });

  test("rejects concurrent auth for the same server with AuthFlowInProgressError", async () => {
    const db = createDb();
    let resolveFirstFlow!: (code: string) => void;
    const firstFlowCode = new Promise<string>((r) => {
      resolveFirstFlow = r;
    });

    const first = runOAuthFlowWithDcrRetry(
      SERVER,
      SERVER_URL,
      db,
      {},
      {
        authFn: async (_provider, opts) => (opts.authorizationCode ? "AUTHORIZED" : "REDIRECT"),
        startCallbackServer: () => makeCallback(firstFlowCode),
      },
    );

    // Second call for the same server while first is in progress
    await expect(
      runOAuthFlowWithDcrRetry(
        SERVER,
        SERVER_URL,
        db,
        {},
        {
          authFn: async () => "AUTHORIZED",
          startCallbackServer: () => makeCallback(Promise.resolve("code")),
        },
      ),
    ).rejects.toBeInstanceOf(AuthFlowInProgressError);

    // Complete the first flow
    resolveFirstFlow("code-abc");
    const result = await first;
    expect(result).toBe("authenticated");
    db.close();
  });

  test("allows concurrent auth for different servers", async () => {
    const db = createDb();
    let resolveA!: (code: string) => void;
    const codeA = new Promise<string>((r) => {
      resolveA = r;
    });

    const flowA = runOAuthFlowWithDcrRetry(
      "server-a",
      SERVER_URL,
      db,
      {},
      {
        authFn: async (_provider, opts) => (opts.authorizationCode ? "AUTHORIZED" : "REDIRECT"),
        startCallbackServer: () => makeCallback(codeA),
      },
    );

    // Different server — should not be blocked
    const flowB = runOAuthFlowWithDcrRetry(
      "server-b",
      SERVER_URL,
      db,
      {},
      {
        authFn: async (_provider, opts) => (opts.authorizationCode ? "AUTHORIZED" : "REDIRECT"),
        startCallbackServer: () => makeCallback(Promise.resolve("code-b")),
      },
    );

    const resultB = await flowB;
    expect(resultB).toBe("authenticated");

    resolveA("code-a");
    const resultA = await flowA;
    expect(resultA).toBe("authenticated");
    db.close();
  });

  test("guard is released after flow failure, allowing retry", async () => {
    const db = createDb();

    // First flow fails
    await expect(
      runOAuthFlowWithDcrRetry(
        SERVER,
        SERVER_URL,
        db,
        {},
        {
          authFn: async () => "REDIRECT",
          startCallbackServer: () => makeCallback(Promise.reject(new Error("provider error"))),
        },
      ),
    ).rejects.toThrow("provider error");

    // Second flow for same server should succeed (guard released)
    const result = await runOAuthFlowWithDcrRetry(
      SERVER,
      SERVER_URL,
      db,
      {},
      {
        authFn: async (_provider, opts) => (opts.authorizationCode ? "AUTHORIZED" : "REDIRECT"),
        startCallbackServer: () => makeCallback(Promise.resolve("code-retry")),
      },
    );
    expect(result).toBe("authenticated");
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
