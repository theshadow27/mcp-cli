#!/usr/bin/env bun
/**
 * Mock Claude Code WS client for integration testing (#1681).
 *
 * Connects to --sdk-url, receives the initial user message, then sends a
 * minimal session lifecycle (init → assistant → result) before exiting.
 * Used to exercise the full daemon dispatch path without a real claude binary.
 */

const args = process.argv.slice(2);

// Handle --version probes from the daemon's binary-resolver (#1808/#1835).
// Without this, the resolver's spawn of `<claude> --version` exits 1, the
// worker boots in spawnDisabledReason mode, and any test that calls
// claude_prompt times out at 30s — which then makes scripts/check-coverage.ts
// exit non-zero with a 500KB stderr write in flight, truncating output at
// the kernel pipe buffer (~74KB) and hiding the real failure. See #1870.
if (args.includes("--version") || args.includes("-v")) {
  // Report a pre-2.1.120 version so the daemon's binary-resolver picks the
  // noop / legacy ws:// strategy — no patched binary or TLS material needed
  // for the test fixture.
  process.stdout.write("2.1.119 (mock-claude)\n");
  process.exit(0);
}

const sdkUrlIdx = args.indexOf("--sdk-url");
if (sdkUrlIdx === -1 || !args[sdkUrlIdx + 1]) {
  process.stderr.write("mock-claude: missing --sdk-url\n");
  process.exit(1);
}
const sdkUrl = args[sdkUrlIdx + 1];

const urlMatch = sdkUrl.match(/\/session\/([^/?#]+)/);
if (!urlMatch?.[1]) {
  process.stderr.write(`mock-claude: cannot parse session ID from ${sdkUrl}\n`);
  process.exit(1);
}
const sessionId = urlMatch[1];

function ndjson(msg: object): string {
  return `${JSON.stringify(msg)}\n`;
}

async function run(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(sdkUrl);

    ws.onmessage = (ev) => {
      const lines = String(ev.data).split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (msg.type === "user") {
          ws.send(
            ndjson({
              type: "system",
              subtype: "init",
              cwd: "/tmp",
              session_id: sessionId,
              tools: [],
              mcp_servers: [],
              model: "claude-sonnet-4-6",
              permissionMode: "default",
              apiKeySource: "test",
              claude_code_version: "2.1.0",
              uuid: "mock-init",
            }),
          );
          ws.send(
            ndjson({
              type: "assistant",
              message: {
                id: "mock-msg-1",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-6",
                content: [{ type: "text", text: "Done." }],
                stop_reason: "end_turn",
                usage: { input_tokens: 100, output_tokens: 50 },
              },
              parent_tool_use_id: null,
              uuid: "mock-assistant",
              session_id: sessionId,
            }),
          );
          ws.send(
            ndjson({
              type: "result",
              subtype: "success",
              is_error: false,
              result: "task done",
              duration_ms: 100,
              duration_api_ms: 80,
              num_turns: 3,
              total_cost_usd: 0.042,
              usage: { input_tokens: 100, output_tokens: 50 },
              uuid: "mock-result",
              session_id: sessionId,
            }),
          );
          setTimeout(() => ws.close(), 200);
        }
      }
    };

    ws.onerror = () => reject(new Error("mock-claude WS error"));
    ws.onclose = () => resolve();
  });
}

run()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(`mock-claude error: ${err}\n`);
    process.exit(1);
  });
