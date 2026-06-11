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

/** Standard "schedule the next protocol step" delay — long enough for the daemon to observe the prior frame. */
const STEP_DELAY_MS = 30;
/** Tail delay after a server-request (approval) before completing the turn. */
const POST_APPROVAL_COMPLETE_DELAY_MS = 100;
/** Tail delay before `process.exit()` in crash-after-turn mode. */
const CRASH_EXIT_DELAY_MS = 50;

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
    // In validate-input mode, assert that threadId and input match the Codex protocol.
    if (mode === "validate-input") {
      const params = msg.params as Record<string, unknown> | undefined;
      if (typeof params?.threadId !== "string" || params.threadId.length === 0) {
        respond(msg.id, null);
        process.stderr.write(`FAIL: threadId must be a non-empty string, got ${JSON.stringify(params?.threadId)}\n`);
        process.exit(1);
      }
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
      setTimeout(() => sendTurnCompleted(), POST_APPROVAL_COMPLETE_DELAY_MS);
    }, STEP_DELAY_MS);
  } else if (mode === "approval-escape") {
    // Request approval for a git write that targets a path OUTSIDE the worktree.
    // A worktree session's containment guard must deny this regardless of policy.
    setTimeout(() => {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: { approvalId: "approval-1", command: "git -C /etc commit -m pwned", cwd: process.cwd() },
        })}\n`,
      );
      setTimeout(() => sendTurnCompleted(), POST_APPROVAL_COMPLETE_DELAY_MS);
    }, STEP_DELAY_MS);
  } else if (mode === "filechange-escape") {
    // A multi-file patch whose FIRST file is inside the worktree but a later
    // file escapes it. Containment must validate every path, not just files[0],
    // and deny the whole patch (#2519). item/started populates the tracked file
    // set; the fileChange approval then references that itemId.
    setTimeout(() => {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "item-1",
              type: "fileChange",
              status: "inProgress",
              changes: [
                { path: "ok.ts", kind: "modify", diff: "" },
                { path: "/etc/codex-filechange-escape.txt", kind: "add", diff: "" },
              ],
            },
          },
        })}\n`,
      );
      setTimeout(() => {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: "approval-1",
            method: "item/fileChange/requestApproval",
            params: { approvalId: "approval-1", itemId: "item-1" },
          })}\n`,
        );
        setTimeout(() => sendTurnCompleted(), POST_APPROVAL_COMPLETE_DELAY_MS);
      }, STEP_DELAY_MS);
    }, STEP_DELAY_MS);
  } else if (mode === "crash-after-turn") {
    setTimeout(() => {
      sendTurnCompleted();
      setTimeout(() => process.exit(2), CRASH_EXIT_DELAY_MS);
    }, STEP_DELAY_MS);
  } else if (mode === "validate-input") {
    // input already validated above — complete like simple
    setTimeout(() => sendTurnCompleted(), STEP_DELAY_MS);
  } else if (mode === "silent") {
    // No events after turn/start — process stays alive but silent (for watchdog testing)
  } else {
    // simple
    setTimeout(() => sendTurnCompleted(), STEP_DELAY_MS);
  }
}
