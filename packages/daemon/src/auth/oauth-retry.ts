/**
 * OAuth flow orchestration with DCR retry on callback timeout.
 *
 * When the callback server times out without receiving an authorization code
 * (which may indicate a provider-side 5xx on the authorize endpoint), the
 * cached client registration is discarded and the flow retries once with a
 * fresh DCR. Atlassian and some other providers burn client_ids after a small
 * number of unused authorize attempts.
 */

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { InvalidGrantError, OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { StateDb } from "../db/state";
import { metrics } from "../metrics";
import { type CallbackServer, OAuthCallbackTimeoutError, startCallbackServer } from "./callback-server";
import { DEFAULT_OAUTH_SCOPE, McpOAuthProvider, type OAuthProviderOpts } from "./oauth-provider";

/** Tracks servers with an in-progress auth flow (intra-process async guard). */
const activeAuthFlows = new Set<string>();

export class AuthFlowInProgressError extends Error {
  constructor(server: string) {
    super(`Another auth flow is already in progress for server "${server}" — wait for it to complete or cancel it`);
    this.name = "AuthFlowInProgressError";
  }
}

/** @internal Reset for test isolation. */
export function _resetActiveAuthFlows(): void {
  activeAuthFlows.clear();
}

/**
 * True when the error is an OAuth `invalid_grant` — i.e. the refresh_token
 * was rejected (revoked/rotated/expired). The SDK constructs an
 * `InvalidGrantError` for the `invalid_grant` code; the `errorCode` check is a
 * belt-and-suspenders guard against instanceof gaps (duplicate SDK copies).
 */
function isInvalidGrantError(err: unknown): boolean {
  if (err instanceof InvalidGrantError) return true;
  return err instanceof OAuthError && err.errorCode === "invalid_grant";
}

export interface OAuthRetryDeps {
  authFn?: (
    provider: OAuthClientProvider,
    authOpts: { serverUrl: string; scope?: string; authorizationCode?: string },
  ) => Promise<string>;
  startCallbackServer?: (port?: number) => CallbackServer;
}

/**
 * Run the OAuth authorization_code flow, retrying once with a fresh DCR if
 * the callback server times out (post-hoc detection that the authorize
 * endpoint may have returned 5xx).
 *
 * Returns "already_authorized" when the provider's cached tokens are still
 * valid, or "authenticated" after a successful code exchange.
 */
export async function runOAuthFlowWithDcrRetry(
  server: string,
  serverUrl: string,
  db: StateDb,
  opts: Pick<
    OAuthProviderOpts,
    "clientId" | "clientSecret" | "callbackPort" | "scope" | "readKeychain" | "skipKeychainTokens"
  >,
  deps?: OAuthRetryDeps,
): Promise<"already_authorized" | "authenticated"> {
  if (activeAuthFlows.has(server)) {
    throw new AuthFlowInProgressError(server);
  }
  activeAuthFlows.add(server);
  try {
    return await _runFlow(server, serverUrl, db, opts, deps);
  } finally {
    activeAuthFlows.delete(server);
  }
}

async function _runFlow(
  server: string,
  serverUrl: string,
  db: StateDb,
  opts: Pick<
    OAuthProviderOpts,
    "clientId" | "clientSecret" | "callbackPort" | "scope" | "readKeychain" | "skipKeychainTokens"
  >,
  deps?: OAuthRetryDeps,
): Promise<"already_authorized" | "authenticated"> {
  const doAuth =
    deps?.authFn ??
    ((provider: OAuthClientProvider, authOpts: { serverUrl: string; scope?: string; authorizationCode?: string }) =>
      auth(provider, authOpts));
  const makeCallback = deps?.startCallbackServer ?? startCallbackServer;

  // Two independent one-shot recoveries: a DCR timeout burns the keychain
  // client_id; an invalid_grant burns the keychain tokens. Each gets its own
  // budget (a shared counter would let one starve the other), so a server that
  // needs both can recover from both. Total attempts are still bounded to
  // initial + one retry per cause.
  let skipKeychainClientId = false;
  let skipKeychainTokens = opts.skipKeychainTokens ?? false;
  let dcrRetried = false;
  let invalidGrantRetried = false;
  const MAX_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const callback = makeCallback(opts.callbackPort);
    try {
      const provider = new McpOAuthProvider(server, serverUrl, db, {
        ...opts,
        skipKeychainClientId,
        skipKeychainTokens,
      });
      provider.setRedirectUrl(callback.url);
      const authScope = provider.getEffectiveScope() ?? DEFAULT_OAUTH_SCOPE;

      const result = await doAuth(provider, { serverUrl, scope: authScope });
      if (result === "AUTHORIZED") {
        return "already_authorized";
      }

      // result === "REDIRECT" — browser opened; wait for the authorization code
      const code = await callback.waitForCode;
      await doAuth(provider, { serverUrl, authorizationCode: code });
      if (dcrRetried) {
        metrics.counter("oauth_dcr_retry_total", { server, outcome: "success" }).inc();
      }
      if (invalidGrantRetried) {
        metrics.counter("oauth_refresh_retry_total", { server, outcome: "success" }).inc();
      }
      return "authenticated";
    } catch (err) {
      const isTimeout = err instanceof OAuthCallbackTimeoutError;
      if (isTimeout && !dcrRetried) {
        console.error(
          "[auth] OAuth callback timed out (possibly 5xx on authorize) — deleting cached client registration and retrying...",
        );
        dcrRetried = true;
        skipKeychainClientId = true;
        db.deleteClientInfo(server);
        continue;
      }
      if (isTimeout) {
        metrics.counter("oauth_dcr_retry_total", { server, outcome: "double_timeout" }).inc();
        throw new Error(
          "OAuth callback timed out twice; no recovery available — authorization failed after DCR retry",
          { cause: err },
        );
      }
      if (isInvalidGrantError(err) && !invalidGrantRetried) {
        console.error(
          `[auth] refresh token for "${server}" was rejected (invalid_grant) — clearing stored tokens and retrying via browser...`,
        );
        // Delete SQLite tokens; the retry provider skips the keychain fallback
        // so the revoked refresh_token is not re-served (would loop otherwise).
        new McpOAuthProvider(server, serverUrl, db).invalidateCredentials("tokens");
        invalidGrantRetried = true;
        skipKeychainTokens = true;
        metrics.counter("oauth_refresh_retry_total", { server, outcome: "triggered" }).inc();
        continue;
      }
      throw err;
    } finally {
      callback.stop();
    }
  }

  // Unreachable — loop always returns or throws
  throw new Error("runOAuthFlowWithDcrRetry: unexpected loop exit");
}
