/**
 * Fake Codex App Server for testing.
 *
 * Reads JSON-RPC requests from stdin and responds appropriately.
 * Mode is set via process.argv[2]:
 *   simple        (default) — handshake + turn/completed, clean exit
 *   approval      — handshake + turn + commandExecution approval request + turn/completed
 *   crash-after-turn — handshake + turn/completed + exit code 2
 *   silent        — handshake + turn/start response, then no events (for watchdog testing)
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
    respond(msg.id, { userAgent: "codex-fake/0.0.1" });
  } else if (method === "thread/start") {
    respond(msg.id, { thread: { id: "thread-1", status: "idle", cwd: process.cwd() } });
  } else if (method === "turn/start") {
    // In validate-input mode, assert that input is an array of elements
    if (mode === "validate-input") {
      const params = msg.params as Record<string, unknown> | undefined;
      const input = params?.input;
      if (!Array.isArray(input)) {
        respond(msg.id, null);
        process.stderr.write(`FAIL: input must be array, got ${JSON.stringify(input)}\n`);
        process.exit(1);
      }
      const elem = input[0] as Record<string, unknown> | undefined;
      if (!elem || elem.type !== "text" || typeof elem.text !== "string") {
        respond(msg.id, null);
        process.stderr.write(`FAIL: input[0] must be {type:"text",text:string}, got ${JSON.stringify(elem)}\n`);
        process.exit(1);
      }
    }
    respond(msg.id, { turn: { id: "turn-1", status: "inProgress", error: null } });
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
      params: { threadId: "thread-1", turn: { id: "turn-1", status, error: null } },
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
  } else if (mode === "validate-input") {
    // input already validated above — complete like simple
    setTimeout(() => sendTurnCompleted(), 30);
  } else if (mode === "silent") {
    // No events after turn/start — process stays alive but silent (for watchdog testing)
  } else {
    // simple
    setTimeout(() => sendTurnCompleted(), 30);
  }
}
