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
import type { StateDb } from "../db/state";
import { metrics } from "../metrics";
import { type CallbackServer, OAuthCallbackTimeoutError, startCallbackServer } from "./callback-server";
import { DEFAULT_OAUTH_SCOPE, McpOAuthProvider, type OAuthProviderOpts } from "./oauth-provider";

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
  opts: Pick<OAuthProviderOpts, "clientId" | "clientSecret" | "callbackPort" | "scope" | "readKeychain">,
  deps?: OAuthRetryDeps,
): Promise<"already_authorized" | "authenticated"> {
  const doAuth =
    deps?.authFn ??
    ((provider: OAuthClientProvider, authOpts: { serverUrl: string; scope?: string; authorizationCode?: string }) =>
      auth(provider, authOpts));
  const makeCallback = deps?.startCallbackServer ?? startCallbackServer;
  const MAX_RETRIES = 1;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const skipKeychainClientId = attempt > 0;
    const callback = makeCallback(opts.callbackPort);
    try {
      const provider = new McpOAuthProvider(server, serverUrl, db, {
        ...opts,
        skipKeychainClientId,
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
      if (skipKeychainClientId) {
        metrics.counter("oauth_dcr_retry_total", { server, outcome: "success" }).inc();
      }
      return "authenticated";
    } catch (err) {
      const isTimeout = err instanceof OAuthCallbackTimeoutError;
      if (isTimeout && attempt < MAX_RETRIES) {
        console.error(
          "[auth] OAuth callback timed out (possibly 5xx on authorize) — deleting cached client registration and retrying...",
        );
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
      throw err;
    } finally {
      callback.stop();
    }
  }

  // Unreachable — loop always returns or throws
  throw new Error("runOAuthFlowWithDcrRetry: unexpected loop exit");
}
