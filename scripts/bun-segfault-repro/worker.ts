/**
 * Minimal worker for Bun segfault reproduction (see #1004, oven-sh/bun#28415).
 *
 * This worker creates deferred async work (server I/O, timers, fetch calls)
 * that remains pending when the parent terminates it. The orphaned
 * JSC::DeferredWorkTimer tickets are the root cause of the crash.
 *
 * Run via: scripts/bun-segfault-repro/repro.test.ts
 */

declare const self: Worker;

// Start a lightweight HTTP server — creates deferred I/O callbacks in JSC.
const server = Bun.serve({
  port: 0,
  fetch() {
    return new Response("ok");
  },
});

// Keep issuing fetch calls so there are always pending DeferredWorkTimer tickets
// when the parent terminates this worker.
const interval = setInterval(async () => {
  try {
    await fetch(`http://localhost:${server.port}/`);
  } catch {
    // Worker may be shutting down; ignore fetch errors.
  }
}, 50);

self.postMessage({ type: "ready", port: server.port });

self.onmessage = (event: MessageEvent) => {
  if (event.data?.type === "stop") {
    clearInterval(interval);
    server.stop(true);
  }
};
