/**
 * Minimal reproduction for Bun segfault in JSC::DeferredWorkTimer.
 *
 * Upstream issue: oven-sh/bun#28415
 * Fix PR: oven-sh/bun#27960
 *
 * Root cause: DeferredWorkTimer tickets hold raw JSCell* pointers that become
 * dangling after worker VM shutdown. The crash occurs during Bun's internal
 * teardown (after all user code completes), when the timer tries to visit
 * or cancel deferred work referencing freed cells.
 *
 * This repro maximizes crash probability by:
 * 1. Spawning many workers (80+), each running an HTTP server + async work
 * 2. Terminating all workers rapidly
 * 3. Repeating in a tight loop to increase the chance of hitting the race
 *
 * Expected: crashes with SIGSEGV on Linux x64 (Bun v1.3.x) within a few iterations.
 * On macOS, the crash is not observed (different memory allocator behavior).
 */

const WORKERS_PER_BATCH = 80;
const ITERATIONS = 5;

// Worker code as a blob URL — each worker starts an HTTP server,
// schedules some async work (timers + promises + fetch), then waits
// for termination.
const workerCode = `
const server = Bun.serve({
  port: 0,
  fetch(req) {
    return new Response(JSON.stringify({ pid: process.pid, time: Date.now() }), {
      headers: { "Content-Type": "application/json" },
    });
  },
});

// Schedule deferred work — this is what creates DeferredWorkTimer tickets
// that hold JSCell* pointers. More async work = more dangling pointers.
const intervals = [];
for (let i = 0; i < 3; i++) {
  intervals.push(setInterval(() => {
    // Create garbage that JSC needs to track
    const obj = { data: new ArrayBuffer(1024), ts: Date.now() };
    void Promise.resolve(obj).then(o => o.ts);
  }, 10));
}

// Unresolved promises — these create DeferredWorkTimer entries
const pending = [];
for (let i = 0; i < 5; i++) {
  pending.push(new Promise(resolve => {
    setTimeout(resolve, 60_000); // never resolves before termination
  }));
}

// Signal ready
postMessage({ type: "ready", port: server.port });
`;

const blob = new Blob([workerCode], { type: "application/javascript" });
const workerUrl = URL.createObjectURL(blob);

async function spawnAndTerminateBatch(batchNum: number): Promise<void> {
  const workers: Worker[] = [];
  const readyCount = { value: 0 };

  const allReady = new Promise<void>((resolve) => {
    const check = () => {
      if (readyCount.value >= WORKERS_PER_BATCH) resolve();
    };

    for (let i = 0; i < WORKERS_PER_BATCH; i++) {
      const w = new Worker(workerUrl);
      w.onmessage = (ev) => {
        if (ev.data?.type === "ready") {
          readyCount.value++;
          check();
        }
      };
      w.onerror = (ev) => {
        // Some workers may fail to start under pressure — that's fine
        readyCount.value++;
        check();
      };
      workers.push(w);
    }
  });

  // Wait for all workers to be ready (or timeout after 30s)
  const timeout = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error("Timed out waiting for workers")), 30_000),
  );

  try {
    await Promise.race([allReady, timeout]);
  } catch (e) {
    console.error(`  Batch ${batchNum}: ${readyCount.value}/${WORKERS_PER_BATCH} ready before timeout`);
  }

  console.error(`  Batch ${batchNum}: ${readyCount.value} workers ready, terminating all...`);

  // Terminate all workers as fast as possible — this is the trigger.
  // Rapid termination while deferred work is pending creates dangling pointers.
  for (const w of workers) {
    w.terminate();
  }

  // Brief pause to let Bun's internal cleanup run (but not too long)
  await new Promise((r) => setTimeout(r, 100));

  console.error(`  Batch ${batchNum}: terminated`);
}

async function main() {
  console.error(`Bun segfault repro — ${WORKERS_PER_BATCH} workers x ${ITERATIONS} iterations`);
  console.error(`Bun version: ${Bun.version}`);
  console.error(`Platform: ${process.platform} ${process.arch}`);
  console.error("");

  for (let i = 1; i <= ITERATIONS; i++) {
    console.error(`Iteration ${i}/${ITERATIONS}:`);
    await spawnAndTerminateBatch(i);
  }

  console.error("");
  console.error("All iterations completed without crash.");
  console.error("If running on Linux x64, try increasing WORKERS_PER_BATCH or ITERATIONS.");

  // Force a GC to trigger any remaining dangling pointer access
  Bun.gc(true);
  await new Promise((r) => setTimeout(r, 500));
  Bun.gc(true);

  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
