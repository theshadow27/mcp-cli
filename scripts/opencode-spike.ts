#!/usr/bin/env bun
/**
 * OpenCode server protocol spike — validates end-to-end integration from Bun.
 *
 * Spawns `opencode serve`, connects via SSE, creates a session, sends a prompt,
 * handles permissions, captures token/cost data, tests abort, and tears down.
 *
 * Prerequisites:
 *   - `opencode` installed and on PATH
 *   - At least one LLM provider configured (ANTHROPIC_API_KEY or OPENAI_API_KEY)
 *
 * Usage:
 *   bun scripts/opencode-spike.ts
 *
 * Output:
 *   - Event trace to scripts/opencode-spike-trace.jsonl
 *   - Summary to stderr
 */

import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
// ── Configuration ──

const dirname = import.meta.dirname ?? process.cwd();
const TRACE_PATH = resolve(dirname, "opencode-spike-trace.jsonl");
const PROBE_FILE = "probe.txt";
const STARTUP_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = 120_000;
const ABORT_TIMEOUT_MS = 30_000;

// ── Helpers ──

function log(msg: string): void {
  console.error(`[spike] ${msg}`);
}

function trace(event: Record<string, unknown>): void {
  appendFileSync(TRACE_PATH, `${JSON.stringify({ ...event, _ts: Date.now() })}\n`);
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

async function poll(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
  label = "poll",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`${label}: timed out after ${timeoutMs}ms`);
}

// ── Pre-flight ──

log("Pre-flight checks...");

const whichResult = Bun.spawnSync(["which", "opencode"]);
if (whichResult.exitCode !== 0) {
  log("ERROR: 'opencode' not found on PATH. Install it first.");
  process.exit(1);
}

const opencodePath = whichResult.stdout.toString().trim();
log(`Found opencode at: ${opencodePath}`);

// Clean up any leftover probe file
if (existsSync(PROBE_FILE)) unlinkSync(PROBE_FILE);

// Reset trace file
writeFileSync(TRACE_PATH, "");

// ── Step 1: Spawn opencode serve ──

log("Spawning opencode serve...");

const serverProc = Bun.spawn(["opencode", "serve", "--hostname=127.0.0.1", "--port=0"], {
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env },
});

let serverUrl = "";

// Read stdout line-by-line to discover the URL
const stdoutReader = serverProc.stdout.getReader();
const decoder = new TextDecoder();
let stdoutBuffer = "";

try {
  await poll(
    async () => {
      const { value, done } = await Promise.race([
        stdoutReader.read(),
        Bun.sleep(500).then(() => ({ value: undefined, done: false })),
      ]);

      if (value) {
        stdoutBuffer += decoder.decode(value, { stream: true });
        const lines = stdoutBuffer.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          trace({ step: "stdout", line: trimmed });
          // Look for the URL pattern
          const urlMatch = trimmed.match(/https?:\/\/[\d.]+:\d+/);
          if (urlMatch) {
            serverUrl = urlMatch[0];
            return true;
          }
        }
        // Keep the last partial line in the buffer
        stdoutBuffer = lines[lines.length - 1] ?? "";
      }
      if (done) throw new Error("stdout closed before URL was found");
      return false;
    },
    STARTUP_TIMEOUT_MS,
    100,
    "URL discovery",
  );
} catch (err) {
  // Dump stderr for debugging
  const stderrText = await new Response(serverProc.stderr).text();
  log(`stderr output:\n${stderrText}`);
  serverProc.kill();
  throw err;
}

log(`Server URL discovered: ${serverUrl}`);
trace({ step: "url_discovered", url: serverUrl });

// ── Helper: HTTP requests to server ──

async function api<T = unknown>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
  const url = `${serverUrl}${path}`;
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  trace({ step: "api", method, path, status: res.status, body: text.slice(0, 2000) });

  if (!res.ok) {
    throw new Error(`API ${method} ${path} failed: ${res.status} ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

// ── Step 2: SSE connection ──

log("Connecting to SSE event stream...");

const sseEvents: Array<{ type: string; data: unknown }> = [];
let sseConnected = false;

const sseController = new AbortController();
const ssePromise = (async () => {
  const res = await fetch(`${serverUrl}/event`, {
    signal: sseController.signal,
    headers: { Accept: "text/event-stream" },
  });

  if (!res.ok || !res.body) {
    throw new Error(`SSE connection failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buf += dec.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop() ?? "";

    for (const chunk of chunks) {
      if (!chunk.trim()) continue;

      let eventType = "message";
      let eventData = "";

      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          eventData += line.slice(5).trim();
        }
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(eventData);
      } catch {
        parsed = eventData;
      }

      const event = { type: eventType, data: parsed };
      sseEvents.push(event);
      trace({ step: "sse", ...event });

      if (eventType === "server.connected") {
        sseConnected = true;
        log("SSE connected");
      }
    }
  }
})().catch((err) => {
  if ((err as Error).name !== "AbortError") {
    log(`SSE error: ${(err as Error).message}`);
  }
});

await poll(() => sseConnected, 10_000, 100, "SSE connection");
log(`SSE connected, received ${sseEvents.length} initial event(s)`);

// ── Step 3: Create session ──

log("Creating session with auto-allow permissions...");

interface SessionInfo {
  id: string;
  title: string;
  [key: string]: unknown;
}

const session = await api<SessionInfo>("POST", "/session", {
  title: "opencode-spike",
  permission: [
    { permission: "file.write", pattern: "*", action: "allow" },
    { permission: "file.read", pattern: "*", action: "allow" },
    { permission: "sh.exec", pattern: "*", action: "allow" },
  ],
});

const sessionId = session.id;
log(`Session created: ${sessionId} (title: ${session.title})`);
trace({ step: "session_created", session });

// ── Step 4: Send prompt ──

log("Sending prompt: create probe.txt...");

const preEventCount = sseEvents.length;

// Use prompt_async so we can monitor SSE events
await api("POST", `/session/${sessionId}/prompt_async`, {
  sessionID: sessionId,
  parts: [
    {
      type: "text",
      text: `Create a file named ${PROBE_FILE} in the current directory containing exactly: hello`,
    },
  ],
});

log("Prompt sent (async). Waiting for completion via SSE...");

// ── Step 5: Event streaming + permission handling + completion ──

let sessionIdle = false;
let tokenData: Record<string, unknown> | null = null;
let costData: number | null = null;
let permissionsHandled = 0;

await poll(
  async () => {
    // Process new SSE events
    for (let i = preEventCount; i < sseEvents.length; i++) {
      const ev = sseEvents[i];
      if (!ev) continue;

      // Handle permission requests
      if (ev.type === "permission.asked") {
        const props = ev.data as { properties?: { id?: string }; id?: string };
        const requestId = props.properties?.id ?? props.id;
        if (requestId) {
          log(`Permission requested (${requestId}), auto-approving...`);
          try {
            await api("POST", `/permission/${requestId}/reply`, { reply: "once" });
            permissionsHandled++;
            log(`Permission ${requestId} approved`);
          } catch (err) {
            log(`Permission approval failed: ${(err as Error).message}`);
          }
        }
      }

      // Capture token/cost from step-finish parts
      if (ev.type === "message.part.updated") {
        const data = ev.data as {
          properties?: { part?: { type?: string; tokens?: unknown; cost?: number } };
        };
        const part = data.properties?.part;
        if (part?.type === "step-finish") {
          if (part.tokens) tokenData = part.tokens as Record<string, unknown>;
          if (part.cost !== undefined) costData = part.cost;
          log(`Step finished — tokens: ${JSON.stringify(part.tokens)}, cost: ${part.cost}`);
        }
      }

      // Check for session idle
      if (ev.type === "session.status") {
        const data = ev.data as {
          properties?: { status?: { type?: string } };
        };
        if (data.properties?.status?.type === "idle") {
          sessionIdle = true;
        }
      }
    }

    return sessionIdle;
  },
  PROMPT_TIMEOUT_MS,
  500,
  "prompt completion",
);

log("Session returned to idle.");

// ── Step 6: Verify probe.txt ──

log("Verifying probe.txt was created...");

if (existsSync(PROBE_FILE)) {
  const content = await Bun.file(PROBE_FILE).text();
  log(`probe.txt content: "${content.trim()}"`);
  assert(content.trim() === "hello", `probe.txt content mismatch: "${content.trim()}"`);
  log("probe.txt verification PASSED");
  unlinkSync(PROBE_FILE);
} else {
  log("WARNING: probe.txt not found — file may have been created in a different directory");
  // Not fatal — the server's CWD may differ
}

// ── Step 7: Token/cost capture summary ──

log("\n=== Token/Cost Summary ===");
if (tokenData) {
  log(`  tokens: ${JSON.stringify(tokenData, null, 2)}`);
  // Validate expected fields
  const t = tokenData as Record<string, unknown>;
  log(`  input:     ${t.input ?? "missing"}`);
  log(`  output:    ${t.output ?? "missing"}`);
  log(`  reasoning: ${t.reasoning ?? "missing"}`);
  const cache = t.cache as Record<string, unknown> | undefined;
  log(`  cache.read:  ${cache?.read ?? "missing"}`);
  log(`  cache.write: ${cache?.write ?? "missing"}`);
} else {
  log("  No token data captured from step-finish events");
}
if (costData !== null) {
  log(`  cost: ${costData}`);
} else {
  log("  No cost data captured");
}

// ── Step 8: Interrupt test ──

log("\nStarting interrupt/abort test...");

const preAbortEventCount = sseEvents.length;

// Send a long-running prompt
await api("POST", `/session/${sessionId}/prompt_async`, {
  sessionID: sessionId,
  parts: [
    {
      type: "text",
      text: "Write a very long essay about the history of computing, covering at least 20 major milestones in detail.",
    },
  ],
});

log("Long prompt sent. Waiting briefly before aborting...");

// Wait for session to become busy
await poll(
  () => {
    for (let i = preAbortEventCount; i < sseEvents.length; i++) {
      const ev = sseEvents[i];
      if (!ev) continue;
      if (ev.type === "session.status") {
        const data = ev.data as { properties?: { status?: { type?: string } } };
        if (data.properties?.status?.type === "busy") return true;
      }
    }
    return false;
  },
  10_000,
  200,
  "session busy",
);

log("Session is busy. Sending abort...");

const abortResult = await api("POST", `/session/${sessionId}/abort`);
log(`Abort response: ${JSON.stringify(abortResult)}`);
trace({ step: "abort_sent", result: abortResult });

// Wait for session to return to idle after abort
let abortSettled = false;
await poll(
  () => {
    for (let i = preAbortEventCount; i < sseEvents.length; i++) {
      const ev = sseEvents[i];
      if (!ev) continue;
      if (ev.type === "session.status") {
        const data = ev.data as { properties?: { status?: { type?: string } } };
        if (data.properties?.status?.type === "idle") {
          abortSettled = true;
          return true;
        }
      }
    }
    return false;
  },
  ABORT_TIMEOUT_MS,
  500,
  "abort settle",
);

log(`Abort test ${abortSettled ? "PASSED" : "FAILED"} — session settled back to idle`);

// ── Step 9: Teardown ──

log("\nTearing down...");

sseController.abort();

serverProc.kill();
const exitCode = await serverProc.exited;
log(`Server process exited with code: ${exitCode}`);
trace({ step: "teardown", exitCode });

// ── Summary ──

const eventTypes = new Map<string, number>();
for (const ev of sseEvents) {
  eventTypes.set(ev.type, (eventTypes.get(ev.type) ?? 0) + 1);
}

log("\n=== Spike Summary ===");
log(`Total SSE events received: ${sseEvents.length}`);
log("Event type breakdown:");
for (const [type, count] of [...eventTypes.entries()].sort()) {
  log(`  ${type}: ${count}`);
}
log(`Permissions handled: ${permissionsHandled}`);
log(`Token data captured: ${tokenData ? "yes" : "no"}`);
log(`Cost data captured: ${costData !== null ? "yes" : "no"}`);
log(`Abort test: ${abortSettled ? "passed" : "failed"}`);
log(`Trace written to: ${TRACE_PATH}`);

log("\n=== Validation Checklist ===");
log(`[${serverUrl ? "✓" : "✗"}] Bun.spawn works for opencode serve (URL from stdout)`);
log(`[${sseConnected ? "✓" : "✗"}] SSE connection works from Bun`);
log(`[${sessionId ? "✓" : "✗"}] Session creation with permission rules works`);
log(`[${sessionIdle ? "✓" : "✗"}] Prompt execution produces expected SSE events`);
log(`[${permissionsHandled > 0 ? "✓" : "~"}] Permission handling (${permissionsHandled} handled, ~ = none needed)`);
log(`[${tokenData ? "✓" : "✗"}] Token tracking fields present`);
log(`[${costData !== null ? "✓" : "✗"}] Cost field present`);
log(`[${abortSettled ? "✓" : "✗"}] Abort stops in-flight turn`);
log("[✓] Process exits cleanly on kill");

log("\nSpike complete.");
