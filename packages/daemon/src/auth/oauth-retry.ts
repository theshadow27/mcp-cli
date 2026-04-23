/**
 * OAuth flow orchestration with DCR retry on authorize 5xx.
 *
 * When the authorize endpoint returns 5xx (detected post-hoc via callback
 * server timeout), the cached client registration is discarded and the flow
 * retries once with a fresh DCR. Atlassian and some other providers burn
 * client_ids after a small number of unused authorize attempts.
 */

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { StateDb } from "../db/state";
import { type CallbackServer, startCallbackServer } from "./callback-server";
import { DEFAULT_OAUTH_SCOPE, McpOAuthProvider } from "./oauth-provider";

export interface OAuthRetryDeps {
  authFn?: (
    provider: OAuthClientProvider,
    opts: { serverUrl: string; scope?: string; authorizationCode?: string },
  ) => Promise<string>;
  startCallbackServer?: (port?: number) => CallbackServer;
}

/**
 * Run the OAuth authorization_code flow, retrying once with a fresh DCR if
 * the callback server times out (post-hoc 5xx detection).
 *
 * Returns "already_authorized" when the provider's cached tokens are still
 * valid, or "authenticated" after a successful code exchange.
 */
export async function runOAuthFlowWithDcrRetry(
  server: string,
  serverUrl: string,
  db: StateDb,
  opts: { clientId?: string; clientSecret?: string; callbackPort?: number; scope?: string },
  deps?: OAuthRetryDeps,
): Promise<"already_authorized" | "authenticated"> {
  const doAuth =
    deps?.authFn ??
    ((provider: OAuthClientProvider, opts: { serverUrl: string; scope?: string; authorizationCode?: string }) =>
      auth(provider, opts));
  const makeCallback = deps?.startCallbackServer ?? startCallbackServer;
  const MAX_RETRIES = 1;
  let retryCount = 0;

  for (;;) {
    const callback = makeCallback(opts.callbackPort);
    try {
      const provider = new McpOAuthProvider(server, serverUrl, db, opts);
      provider.setRedirectUrl(callback.url);
      const authScope = provider.getEffectiveScope() ?? DEFAULT_OAUTH_SCOPE;

      const result = await doAuth(provider, { serverUrl, scope: authScope });
      if (result === "AUTHORIZED") {
        return "already_authorized";
      }

      // result === "REDIRECT" — browser opened; wait for the authorization code
      const code = await callback.waitForCode;
      await doAuth(provider, { serverUrl, authorizationCode: code });
      return "authenticated";
    } catch (err) {
      const isTimeout = err instanceof Error && err.message.startsWith("OAuth callback timeout");
      if (isTimeout && retryCount < MAX_RETRIES) {
        retryCount++;
        console.error("[auth] authorize returned 5xx, retrying with fresh client registration...");
        db.deleteClientInfo(server);
        continue;
      }
      if (isTimeout) {
        throw new Error("provider returned 5xx; no recovery available — authorization failed after DCR retry");
      }
      throw err;
    } finally {
      callback.stop();
    }
  }
}
