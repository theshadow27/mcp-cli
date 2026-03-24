/**
 * Ephemeral HTTP server for OAuth redirect callback.
 *
 * Starts on a random available port, waits for the authorization code
 * from the OAuth redirect, then auto-stops.
 */

export interface CallbackServer {
  /** The full callback URL (http://localhost:{port}/callback) */
  url: string;
  /** The port the server is listening on */
  port: number;
  /** Resolves with the authorization code when received */
  waitForCode: Promise<string>;
  /** Stop the server immediately */
  stop: () => void;
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>mcp-cli</title><style>
body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5}
.card{background:white;padding:2rem;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1);text-align:center}
</style></head><body>
<div class="card"><h2>Authenticated</h2><p>You can close this tab and return to the terminal.</p></div>
</body></html>`;

const ERROR_HTML = `<!DOCTYPE html>
<html><head><title>mcp-cli</title></head><body>
<h2>Authentication Error</h2><p>No authorization code received.</p>
</body></html>`;

export function startCallbackServer(preferredPort?: number): CallbackServer {
  // Promise executor runs synchronously, so these are assigned before use
  let resolveCode = (_code: string): void => {};
  let rejectCode = (_err: Error): void => {};

  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  let stopped = false;
  const server = Bun.serve({
    port: preferredPort ?? 0, // explicit or random available port
    hostname: "localhost",
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          const desc = url.searchParams.get("error_description") ?? error;
          // Defer rejection so the HTTP response is sent before the error propagates
          queueMicrotask(() => rejectCode(new Error(`OAuth error: ${desc}`)));
          return new Response(ERROR_HTML, {
            headers: { "Content-Type": "text/html" },
          });
        }

        if (code) {
          resolveCode(code);
          // Auto-stop after brief delay to ensure response is sent
          setTimeout(() => {
            if (!stopped) {
              stopped = true;
              server.stop(true);
            }
          }, 50);
          return new Response(SUCCESS_HTML, {
            headers: { "Content-Type": "text/html" },
          });
        }

        return new Response(ERROR_HTML, {
          status: 400,
          headers: { "Content-Type": "text/html" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  const port = server.port as number;
  const url = `http://localhost:${port}/callback`;

  // Timeout: reject if no callback within 2 minutes
  const timeout = setTimeout(() => {
    if (!stopped) {
      stopped = true;
      server.stop(true);
      rejectCode(new Error("OAuth callback timeout (2 minutes)"));
    }
  }, 120_000);

  // Clean up timeout when code is received (suppress floating rejection from .finally() chain)
  waitForCode.finally(() => clearTimeout(timeout)).catch(() => {});

  return {
    url,
    port,
    waitForCode,
    stop() {
      if (!stopped) {
        stopped = true;
        clearTimeout(timeout);
        server.stop(true);
      }
    },
  };
}
