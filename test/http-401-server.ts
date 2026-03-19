/**
 * Minimal HTTP server that returns 401 Unauthorized for all requests.
 * Used by daemon-integration.spec.ts to test auth error messages.
 *
 * Prints the listening port to stdout so the test harness can discover it.
 */
const server = Bun.serve({
  port: 0, // OS-assigned port
  fetch() {
    return new Response("Unauthorized", { status: 401 });
  },
});

// Print port for the test to read
console.log(server.port);
