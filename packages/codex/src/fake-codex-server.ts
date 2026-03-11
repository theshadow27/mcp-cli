/**
 * Fake Codex App Server for testing.
 *
 * Reads JSON-RPC requests from stdin and responds appropriately.
 * Mode is set via process.argv[2]:
 *   simple        (default) — handshake + turn/completed, clean exit
 *   approval      — handshake + turn + commandExecution approval request + turn/completed
 *   crash-after-turn — handshake + turn/completed + exit code 2
 */
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "simple";

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed) as Record<string, unknown>;
  const method = msg.method as string | undefined;

  // Only handle requests (have id + method); skip notifications (no id)
  if (msg.id === undefined || !method) return;

  if (method === "initialize") {
    respond(msg.id, { serverInfo: { name: "codex-fake", version: "0.0.1" } });
  } else if (method === "thread/start") {
    respond(msg.id, { id: "thread-1", status: "active" });
  } else if (method === "turn/start") {
    respond(msg.id, { id: "turn-1", status: "active" });
    scheduleEvents();
  } else if (method === "turn/interrupt") {
    respond(msg.id, { status: "interrupted" });
    sendTurnCompleted("interrupted");
  }
  // respondToServerRequest (approval response) — ignore, just let timer complete the turn
});

function respond(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sendTurnCompleted(status = "completed"): void {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turnId: "turn-1", threadId: "thread-1", status },
    })}\n`,
  );
}

function scheduleEvents(): void {
  if (mode === "approval") {
    // Send commandExecution approval request after short delay
    setTimeout(() => {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: { approvalId: "approval-1", command: "npm test", cwd: process.cwd() },
        })}\n`,
      );
      // Complete the turn regardless of approval response
      setTimeout(() => sendTurnCompleted(), 100);
    }, 30);
  } else if (mode === "crash-after-turn") {
    setTimeout(() => {
      sendTurnCompleted();
      setTimeout(() => process.exit(2), 50);
    }, 30);
  } else {
    // simple
    setTimeout(() => sendTurnCompleted(), 30);
  }
}
