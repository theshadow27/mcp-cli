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
 *   terminal        — handshake + session/new + sends terminal/create request, then completes
 */
import { createInterface } from "node:readline";

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
    setTimeout(() => completePrompt(), 30);
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
    }, 10);
    setTimeout(() => {
      sendNotification("session/update", {
        sessionId: acpSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "world!" },
        },
      });
    }, 20);
    setTimeout(() => completePrompt(), 50);
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
      setTimeout(() => completePrompt(), 200);
    }, 30);
  } else if (mode === "crash-after-prompt") {
    setTimeout(() => {
      completePrompt();
      setTimeout(() => process.exit(2), 50);
    }, 30);
  } else if (mode === "silent") {
    // No events after accepting prompt — process stays alive (for watchdog testing)
  } else if (mode === "fs-write") {
    setTimeout(() => {
      sendServerRequest("fs-1", "fs/write_text_file", {
        path: `${process.cwd()}/acp-test-probe.txt`,
        content: "hello from acp",
      });
      setTimeout(() => completePrompt(), 100);
    }, 30);
  } else if (mode === "terminal") {
    setTimeout(() => {
      sendServerRequest("term-1", "terminal/create", {
        command: "echo",
        args: ["hello-terminal"],
        cwd: process.cwd(),
      });
      // After terminal/create response, request output and release
      setTimeout(() => completePrompt(), 200);
    }, 30);
  }
}
