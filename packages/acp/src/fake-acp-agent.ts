/**
 * Fake ACP agent for testing.
 *
 * Reads JSON-RPC requests from stdin and responds per the ACP protocol.
 * Mode is set via process.argv[2]:
 *   simple          (default) — handshake + session/new + session/prompt completes
 *   with-updates    — handshake + session/new + streams session/update chunks before completing
 *   permission      — handshake + session/new + sends session/request_permission, completes after response
 *   crash-after-prompt — handshake + session/new + prompt completes + exit code 2
 *   silent          — handshake + session/new + prompt accepted, then no events (for watchdog testing)
 *   fs-write        — handshake + session/new + sends fs/write_text_file request, then completes
 *   fs-read         — handshake + session/new + sends fs/read_text_file request, then completes
 *   fs-write-traversal — sends fs/write with path traversal (../outside.txt), then completes
 *   fs-write-escape — sends fs/write to an absolute non-/tmp path the containment guard denies
 *   fs-write-oversize — sends fs/write with content over the 50MB size cap, then completes
 *   terminal        — handshake + session/new + sends terminal/create request, then completes
 *   terminal-escape — sends terminal/create with a command targeting a path outside the worktree
 *   terminal-cwd-escape — sends terminal/create with a benign command but a cwd outside the worktree
 */
import { createInterface } from "node:readline";

/** Standard "schedule the next protocol step" delay — long enough for the daemon to observe the prior frame. */
const STEP_DELAY_MS = 30;
/** First streamed `session/update` chunk delay — kept tiny so tests don't drag. */
const STREAM_CHUNK_1_DELAY_MS = 10;
/** Second streamed `session/update` chunk delay — leaves room between frames. */
const STREAM_CHUNK_2_DELAY_MS = 20;
/** Short tail delay before `completePrompt()` / `process.exit()` — final state transition. */
const SHORT_COMPLETE_DELAY_MS = 50;
/** Medium tail delay — paired with fs/read/write server-requests so the daemon round-trips before completion. */
const MED_COMPLETE_DELAY_MS = 100;
/** Long tail delay — paired with permission / terminal flows that require user-side decisions. */
const LONG_COMPLETE_DELAY_MS = 200;

const mode = process.argv[2] ?? "simple";

const rl = createInterface({ input: process.stdin, terminal: false });

const acpSessionId = "test-acp-session";
let promptDone = false;

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed) as Record<string, unknown>;
  const method = msg.method as string | undefined;

  // Only handle requests (have id + method); skip notifications
  if (msg.id === undefined || !method) {
    // Handle notifications like session/cancel
    if (method === "session/cancel") {
      // Complete the pending prompt
      if (!promptDone) {
        promptDone = true;
        respond(pendingPromptId, { stopReason: "end_turn" });
      }
    }
    return;
  }

  if (method === "initialize") {
    respond(msg.id, {
      agentInfo: { name: "fake-acp-agent", version: "0.0.1" },
      protocolVersion: 1,
    });
  } else if (method === "session/new") {
    respond(msg.id, { sessionId: acpSessionId });
  } else if (method === "session/prompt") {
    pendingPromptId = msg.id;
    schedulePromptEvents();
  }
});

let pendingPromptId: unknown = null;

function respond(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sendNotification(method: string, params?: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function sendServerRequest(id: unknown, method: string, params?: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function completePrompt(stopReason = "end_turn"): void {
  if (promptDone) return;
  promptDone = true;
  respond(pendingPromptId, { stopReason });
}

function schedulePromptEvents(): void {
  promptDone = false;

  if (mode === "simple") {
    setTimeout(() => completePrompt(), STEP_DELAY_MS);
  } else if (mode === "with-updates") {
    // Stream some session/update chunks then complete
    setTimeout(() => {
      sendNotification("session/update", {
        sessionId: acpSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello " },
        },
      });
    }, STREAM_CHUNK_1_DELAY_MS);
    setTimeout(() => {
      sendNotification("session/update", {
        sessionId: acpSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "world!" },
        },
      });
    }, STREAM_CHUNK_2_DELAY_MS);
    setTimeout(() => completePrompt(), SHORT_COMPLETE_DELAY_MS);
  } else if (mode === "permission") {
    // Send a permission request
    setTimeout(() => {
      sendServerRequest("perm-1", "session/request_permission", {
        sessionId: acpSessionId,
        tool: "Bash",
        command: "npm test",
        description: "Run npm test",
        options: [
          { optionId: "opt-allow-once", kind: "allow_once", description: "Allow once" },
          { optionId: "opt-allow-always", kind: "allow_always", description: "Allow always" },
          { optionId: "opt-reject-once", kind: "reject_once", description: "Reject" },
        ],
      });
      // Complete after a delay (regardless of permission response)
      setTimeout(() => completePrompt(), LONG_COMPLETE_DELAY_MS);
    }, STEP_DELAY_MS);
  } else if (mode === "crash-after-prompt") {
    setTimeout(() => {
      completePrompt();
      setTimeout(() => process.exit(2), SHORT_COMPLETE_DELAY_MS);
    }, STEP_DELAY_MS);
  } else if (mode === "silent") {
    // No events after accepting prompt — process stays alive (for watchdog testing)
  } else if (mode === "fs-write") {
    setTimeout(() => {
      sendServerRequest("fs-1", "fs/write_text_file", {
        path: `${process.cwd()}/acp-test-probe.txt`,
        content: "hello from acp",
      });
      setTimeout(() => completePrompt(), MED_COMPLETE_DELAY_MS);
    }, STEP_DELAY_MS);
  } else if (mode === "fs-read") {
    setTimeout(() => {
      sendServerRequest("fs-2", "fs/read_text_file", {
        path: `${process.cwd()}/package.json`,
      });
      setTimeout(() => completePrompt(), MED_COMPLETE_DELAY_MS);
    }, STEP_DELAY_MS);
  } else if (mode === "fs-write-traversal") {
    setTimeout(() => {
      sendServerRequest("fs-3", "fs/write_text_file", {
        path: "/tmp/acp-traversal-probe.txt",
        content: "should be blocked",
      });
      setTimeout(() => completePrompt(), MED_COMPLETE_DELAY_MS);
    }, STEP_DELAY_MS);
  } else if (mode === "fs-write-escape") {
    // Absolute path outside the worktree AND outside the /tmp allowlist — the
    // containment guard must deny this for a worktree session (#2519).
    setTimeout(() => {
      sendServerRequest("fs-4", "fs/write_text_file", {
        path: "/etc/acp-containment-escape-probe.txt",
        content: "should be blocked",
      });
      setTimeout(() => completePrompt(), MED_COMPLETE_DELAY_MS);
    }, STEP_DELAY_MS);
  } else if (mode === "fs-write-oversize") {
    // Content exceeds the 50MB write cap — the daemon must reject before any
    // disk write so a looping agent can't fill the shared filesystem (#2732).
    setTimeout(() => {
      sendServerRequest("fs-5", "fs/write_text_file", {
        path: `${process.cwd()}/acp-oversize-probe.txt`,
        content: "x".repeat(50 * 1_024 * 1_024 + 1),
      });
      setTimeout(() => completePrompt(), MED_COMPLETE_DELAY_MS);
    }, STEP_DELAY_MS);
  } else if (mode === "terminal") {
    setTimeout(() => {
      sendServerRequest("term-1", "terminal/create", {
        command: "echo",
        args: ["hello-terminal"],
        cwd: process.cwd(),
      });
      // After terminal/create response, request output and release
      setTimeout(() => completePrompt(), LONG_COMPLETE_DELAY_MS);
    }, STEP_DELAY_MS);
  } else if (mode === "terminal-escape") {
    // Command writes outside the worktree root — containment guard denies (#2519).
    setTimeout(() => {
      sendServerRequest("term-2", "terminal/create", {
        command: "git",
        args: ["-C", "/etc", "commit", "-m", "pwned"],
        cwd: process.cwd(),
      });
      setTimeout(() => completePrompt(), LONG_COMPLETE_DELAY_MS);
    }, STEP_DELAY_MS);
  } else if (mode === "terminal-cwd-escape") {
    // Benign-looking command (not a denylisted writer) but cwd escapes the
    // worktree — only the cwd constraint catches this, not the command parser
    // (#2519, #2720).
    setTimeout(() => {
      sendServerRequest("term-3", "terminal/create", {
        command: "touch",
        args: ["pwned.txt"],
        cwd: "/etc",
      });
      setTimeout(() => completePrompt(), LONG_COMPLETE_DELAY_MS);
    }, STEP_DELAY_MS);
  }
}
