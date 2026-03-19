#!/usr/bin/env bun
/**
 * ACP Protocol Spike — validates the Agent Client Protocol end-to-end
 * with Copilot CLI (and optionally Gemini CLI) from Bun.
 *
 * Usage:
 *   bun scripts/acp-spike.ts [--agent copilot|gemini] [--trace path]
 *
 * Prerequisites:
 *   - `copilot` CLI installed and authenticated
 *   - Or `gemini` CLI installed and authenticated
 *
 * Output:
 *   - Protocol trace → scripts/acp-spike-trace.jsonl (or --trace path)
 *   - Findings summary → stderr
 *
 * @see https://agentclientprotocol.com/protocol/schema
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Config ──

interface Config {
  agent: "copilot" | "gemini";
  tracePath: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  let agent: "copilot" | "gemini" = "copilot";
  let tracePath = join(import.meta.dir, "acp-spike-trace.jsonl");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent" && args[i + 1]) {
      const val = args[++i];
      if (val !== "copilot" && val !== "gemini") {
        console.error(`Unknown agent: ${val}. Use "copilot" or "gemini".`);
        process.exit(1);
      }
      agent = val;
    } else if (args[i] === "--trace" && args[i + 1]) {
      tracePath = args[++i];
    } else {
      console.error(`Unknown arg: ${args[i]}`);
      console.error("Usage: bun scripts/acp-spike.ts [--agent copilot|gemini] [--trace path]");
      process.exit(1);
    }
  }
  return { agent, tracePath };
}

// ── NDJSON / JSON-RPC 2.0 helpers ──

let requestId = 0;
function nextId(): number {
  return ++requestId;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcServerRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcServerRequest | { jsonrpc: "2.0"; method: string; params?: unknown };

function makeRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: "2.0", id: nextId(), method, params };
}

function makeNotification(method: string, params?: Record<string, unknown>): JsonRpcNotification {
  return { jsonrpc: "2.0", method, params };
}

function makeResponse(id: number | string, result: unknown): object {
  return { jsonrpc: "2.0", id, result };
}

// ── Transport ──

class NdjsonTransport {
  private proc: ReturnType<typeof Bun.spawn>;
  private buffer = "";
  private messageQueue: JsonRpcMessage[] = [];
  private waiters: Array<(msg: JsonRpcMessage) => void> = [];
  private tracePath: string;
  private closed = false;
  private readPromise: Promise<void>;

  constructor(
    command: string[],
    tracePath: string,
    private cwd: string,
  ) {
    writeFileSync(tracePath, ""); // truncate
    this.tracePath = tracePath;

    this.proc = Bun.spawn(command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd,
    });

    // Drain stderr to console.error
    this.readPromise = this.readLoop();
    this.drainStderr();
  }

  private async readLoop(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.buffer += decoder.decode(value, { stream: true });
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const msg = JSON.parse(trimmed) as JsonRpcMessage;
            this.trace("recv", msg);

            if (this.waiters.length > 0) {
              const waiter = this.waiters.shift();
              if (waiter) waiter(msg);
            } else {
              this.messageQueue.push(msg);
            }
          } catch {
            console.error(`[transport] Bad JSON: ${trimmed.slice(0, 200)}`);
          }
        }
      }
    } catch (err) {
      if (!this.closed) console.error("[transport] Read error:", err);
    }
  }

  private async drainStderr(): Promise<void> {
    try {
      const text = await new Response(this.proc.stderr).text();
      if (text.trim()) {
        for (const line of text.split("\n")) {
          if (line.trim()) console.error(`[agent stderr] ${line}`);
        }
      }
    } catch {
      // ignore
    }
  }

  private trace(direction: "send" | "recv", msg: unknown): void {
    const entry = { ts: new Date().toISOString(), direction, msg };
    appendFileSync(this.tracePath, `${JSON.stringify(entry)}\n`);
  }

  async send(msg: object): Promise<void> {
    this.trace("send", msg);
    const line = `${JSON.stringify(msg)}\n`;
    this.proc.stdin.write(line);
    await this.proc.stdin.flush();
  }

  /** Wait for the next message from the agent. */
  async recv(timeoutMs = 30_000): Promise<JsonRpcMessage> {
    if (this.messageQueue.length > 0) {
      return this.messageQueue.shift() as JsonRpcMessage;
    }

    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`Timeout waiting for message (${timeoutMs}ms)`));
      }, timeoutMs);

      const waiter = (msg: JsonRpcMessage) => {
        clearTimeout(timer);
        resolve(msg);
      };
      this.waiters.push(waiter);
    });
  }

  /** Send a request and wait for the matching response. */
  async request(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<JsonRpcResponse> {
    const req = makeRequest(method, params);
    await this.send(req);
    const id = req.id;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await this.recv(deadline - Date.now());
      // Check if this is the response to our request
      if ("id" in msg && msg.id === id && !("method" in msg)) {
        return msg as JsonRpcResponse;
      }
      // It's a notification or server request — re-queue it
      this.messageQueue.push(msg);
    }
    throw new Error(`Timeout waiting for response to ${method} (id=${id})`);
  }

  async kill(): Promise<void> {
    this.closed = true;
    try {
      this.proc.stdin.end();
    } catch {
      // ignore
    }

    // Give it a moment to exit gracefully
    const exited = Promise.race([this.proc.exited, new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
    const code = await exited;
    if (code === null) {
      console.error("[transport] Process did not exit, sending SIGTERM");
      this.proc.kill("SIGTERM");
      await Promise.race([this.proc.exited, new Promise((r) => setTimeout(r, 2000))]);
    }
  }

  get exitPromise(): Promise<number> {
    return this.proc.exited;
  }
}

// ── Spike runner ──

interface Findings {
  handshakeOk: boolean;
  capabilities: unknown;
  sessionCreated: boolean;
  sessionId: string | null;
  promptStreaming: boolean;
  updateTypes: Set<string>;
  permissionFormat: unknown | null;
  cancelWorked: boolean;
  tokenInfo: string;
  probeFileCreated: boolean;
  sdkNotes: string;
}

async function runSpike(config: Config): Promise<Findings> {
  const findings: Findings = {
    handshakeOk: false,
    capabilities: null,
    sessionCreated: false,
    sessionId: null,
    promptStreaming: false,
    updateTypes: new Set(),
    permissionFormat: null,
    cancelWorked: false,
    tokenInfo: "not found",
    probeFileCreated: false,
    sdkNotes: "",
  };

  // Create temp working directory
  const workDir = join(tmpdir(), `acp-spike-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  console.error(`[spike] Work directory: ${workDir}`);

  // Determine command
  const command = config.agent === "copilot" ? ["gh", "copilot", "--acp"] : ["gemini", "--acp"];

  console.error(`[spike] Spawning: ${command.join(" ")}`);
  const transport = new NdjsonTransport(command, config.tracePath, workDir);

  try {
    // ── Step 1: Initialize handshake ──
    console.error("\n[spike] === Step 1: Initialize ===");
    const initResp = await transport.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "mcp-cli-spike", version: "0.1.0" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    if (initResp.error) {
      console.error(`[spike] Initialize failed: ${JSON.stringify(initResp.error)}`);
      return findings;
    }

    findings.handshakeOk = true;
    findings.capabilities = initResp.result;
    console.error("[spike] Handshake OK. Capabilities:");
    console.error(JSON.stringify(initResp.result, null, 2));

    // ── Step 2: Create session ──
    console.error("\n[spike] === Step 2: session/new ===");
    const sessionResp = await transport.request("session/new", {
      cwd: workDir,
      mcpServers: [],
    });

    if (sessionResp.error) {
      console.error(`[spike] session/new failed: ${JSON.stringify(sessionResp.error)}`);
      return findings;
    }

    const sessionResult = sessionResp.result as Record<string, unknown>;
    findings.sessionCreated = true;
    findings.sessionId = sessionResult.sessionId as string;
    console.error(`[spike] Session created: ${findings.sessionId}`);
    console.error(`[spike] Session details: ${JSON.stringify(sessionResult, null, 2)}`);

    // ── Step 3: Send prompt and collect streaming updates ──
    console.error("\n[spike] === Step 3: session/prompt (create probe.txt) ===");
    const promptReq = makeRequest("session/prompt", {
      sessionId: findings.sessionId,
      prompt: [{ type: "text", text: "Create a file named probe.txt containing exactly: hello" }],
    });
    await transport.send(promptReq);

    // Collect updates until we get the prompt response
    const promptDeadline = Date.now() + 120_000; // 2 min timeout for LLM work
    let promptDone = false;

    while (!promptDone && Date.now() < promptDeadline) {
      const msg = await transport.recv(promptDeadline - Date.now());

      // Check if it's the prompt response
      if ("id" in msg && msg.id === promptReq.id && !("method" in msg)) {
        const resp = msg as JsonRpcResponse;
        console.error(`[spike] Prompt response: ${JSON.stringify(resp.result)}`);
        if (resp.result) {
          const r = resp.result as Record<string, unknown>;
          if (r.stopReason) console.error(`[spike] Stop reason: ${r.stopReason}`);
        }
        promptDone = true;
        continue;
      }

      // Handle notifications and server requests
      if ("method" in msg) {
        const method = (msg as { method: string }).method;
        const params = (msg as { params?: unknown }).params as Record<string, unknown> | undefined;

        if (method === "session/update") {
          findings.promptStreaming = true;
          // Categorize update type
          if (params) {
            const updateType = params.updateType as string;
            if (updateType) findings.updateTypes.add(updateType);

            const updates = params.updates as Array<Record<string, unknown>> | undefined;
            if (updates) {
              for (const update of updates) {
                findings.updateTypes.add(`update.${update.type}`);
                // Log content chunks
                if (update.type === "content") {
                  const content = update.content as Record<string, unknown>;
                  if (content?.type === "text") {
                    process.stderr.write((content.text as string) ?? "");
                  }
                } else if (update.type === "toolCall") {
                  const tc = update.toolCall as Record<string, unknown>;
                  console.error(`\n[spike] Tool call: ${tc?.name} (${tc?.id})`);
                } else if (update.type === "toolResult") {
                  console.error("[spike] Tool result received");
                } else {
                  console.error(`[spike] Update type: ${update.type}`);
                }
              }
            }

            // Check for token/cost info in updates
            for (const key of ["usage", "tokens", "cost", "tokenUsage"]) {
              if (key in (params ?? {})) {
                findings.tokenInfo = `Found in session/update.${key}: ${JSON.stringify(params[key])}`;
              }
            }
          }
        } else if (method === "session/request_permission") {
          // Auto-approve and capture the format
          console.error(`[spike] Permission request: ${JSON.stringify(params)}`);
          findings.permissionFormat = params;

          // Find the allow_once option
          const options = (params?.options as Array<Record<string, unknown>>) ?? [];
          const allowOnce = options.find((o) => o.kind === "allow_once");
          const optionId = allowOnce?.optionId ?? options[0]?.optionId;

          if ("id" in msg && optionId) {
            const respMsg = makeResponse(msg.id as number | string, {
              outcome: { outcome: "selected", optionId },
            });
            await transport.send(respMsg);
            console.error(`[spike] Auto-approved permission (optionId=${optionId})`);
          }
        } else if (method === "fs/write_text_file") {
          // Agent wants to write a file — handle it
          console.error(`[spike] fs/write_text_file: ${JSON.stringify(params)}`);
          if ("id" in msg && params) {
            const filePath = params.path as string;
            const content = params.content as string;
            try {
              writeFileSync(filePath, content);
              await transport.send(makeResponse(msg.id as number | string, {}));
              console.error(`[spike] Wrote file: ${filePath}`);
            } catch (err) {
              await transport.send({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -1, message: String(err) },
              });
            }
          }
        } else if (method === "fs/read_text_file") {
          console.error(`[spike] fs/read_text_file: ${JSON.stringify(params)}`);
          if ("id" in msg && params) {
            const filePath = params.path as string;
            try {
              const content = readFileSync(filePath, "utf-8");
              await transport.send(makeResponse(msg.id as number | string, { content }));
            } catch (err) {
              await transport.send({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -1, message: String(err) },
              });
            }
          }
        } else if (method === "terminal/create") {
          console.error(`[spike] terminal/create: ${JSON.stringify(params)}`);
          if ("id" in msg && params) {
            // Execute the command and return result
            const cmd = params.command as string;
            const cmdArgs = (params.args as string[]) ?? [];
            const cmdCwd = (params.cwd as string) ?? workDir;
            try {
              const result = Bun.spawnSync([cmd, ...cmdArgs], {
                cwd: cmdCwd,
                stdout: "pipe",
                stderr: "pipe",
              });
              const termId = `term-${Date.now()}`;
              await transport.send(makeResponse(msg.id as number | string, { terminalId: termId }));
              // Store for terminal/output and terminal/wait_for_exit
              terminalResults.set(termId, {
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString(),
                exitCode: result.exitCode,
              });
            } catch (err) {
              await transport.send({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -1, message: String(err) },
              });
            }
          }
        } else if (method === "terminal/output") {
          if ("id" in msg && params) {
            const termId = params.terminalId as string;
            const result = terminalResults.get(termId);
            await transport.send(
              makeResponse(msg.id as number | string, {
                output: result ? result.stdout + result.stderr : "",
                exitCode: result?.exitCode ?? 0,
                isComplete: true,
              }),
            );
          }
        } else if (method === "terminal/wait_for_exit") {
          if ("id" in msg && params) {
            const termId = params.terminalId as string;
            const result = terminalResults.get(termId);
            await transport.send(
              makeResponse(msg.id as number | string, {
                exitCode: result?.exitCode ?? 0,
              }),
            );
          }
        } else if (method === "terminal/release") {
          if ("id" in msg && params) {
            const termId = params.terminalId as string;
            terminalResults.delete(termId);
            await transport.send(makeResponse(msg.id as number | string, {}));
          }
        } else if (method === "terminal/kill") {
          if ("id" in msg) {
            await transport.send(makeResponse(msg.id as number | string, {}));
          }
        } else {
          console.error(`[spike] Unhandled method: ${method} params=${JSON.stringify(params)}`);
          // Respond to requests (have id) with empty result to not block the agent
          if ("id" in msg) {
            await transport.send(makeResponse(msg.id as number | string, {}));
          }
        }
      }
    }

    if (!promptDone) {
      console.error("[spike] WARNING: Prompt timed out after 2 minutes");
    }

    // Check if probe.txt was created
    console.error("\n[spike] === Step 4: Verify probe.txt ===");
    const probePath = join(workDir, "probe.txt");
    findings.probeFileCreated = existsSync(probePath);
    if (findings.probeFileCreated) {
      const content = readFileSync(probePath, "utf-8");
      console.error(`[spike] probe.txt exists! Content: "${content.trim()}"`);
    } else {
      console.error("[spike] probe.txt NOT found");
    }

    // ── Step 5: Test cancellation ──
    console.error("\n[spike] === Step 5: session/cancel ===");
    const longPromptReq = makeRequest("session/prompt", {
      sessionId: findings.sessionId,
      prompt: [{ type: "text", text: "Write a very long essay about the history of computing, at least 5000 words." }],
    });
    await transport.send(longPromptReq);

    // Wait briefly for streaming to start, then cancel
    const cancelWait = Date.now() + 5000;
    let sawUpdateBeforeCancel = false;
    while (Date.now() < cancelWait) {
      try {
        const msg = await transport.recv(1000);
        if ("method" in msg) {
          const method = (msg as { method: string }).method;
          if (method === "session/update") {
            sawUpdateBeforeCancel = true;
            break; // Got at least one update, now cancel
          }
          // Handle any server requests during this phase too
          if ("id" in msg) {
            await transport.send(makeResponse(msg.id as number | string, {}));
          }
        }
      } catch {
        // timeout, try cancel anyway
        break;
      }
    }

    console.error(`[spike] Saw updates before cancel: ${sawUpdateBeforeCancel}`);
    const cancelNotif = makeNotification("session/cancel", {
      sessionId: findings.sessionId,
    });
    await transport.send(cancelNotif);
    console.error("[spike] Sent session/cancel");

    // Wait for the prompt response (should have stopReason: "cancelled")
    const cancelDeadline = Date.now() + 15_000;
    while (Date.now() < cancelDeadline) {
      try {
        const msg = await transport.recv(cancelDeadline - Date.now());
        if ("id" in msg && msg.id === longPromptReq.id && !("method" in msg)) {
          const resp = msg as JsonRpcResponse;
          const result = resp.result as Record<string, unknown> | undefined;
          const stopReason = result?.stopReason;
          console.error(`[spike] Cancel prompt response: stopReason=${stopReason}`);
          findings.cancelWorked = stopReason === "cancelled" || resp.error !== undefined;
          break;
        }
        // Handle server requests
        if ("method" in msg && "id" in msg) {
          await transport.send(makeResponse(msg.id as number | string, {}));
        }
      } catch {
        console.error("[spike] Timeout waiting for cancel response");
        findings.cancelWorked = false;
        break;
      }
    }

    // ── Step 6: Token tracking investigation ──
    console.error("\n[spike] === Step 6: Token tracking ===");
    if (findings.tokenInfo === "not found") {
      console.error("[spike] No token/cost info found in session/update messages");
      console.error("[spike] Checking PromptResponse for usage...");
      // Token info may be in the prompt response result — already captured above
      findings.tokenInfo = "Not found in ACP messages — check session files or agent-specific APIs";
    }
    console.error(`[spike] Token info: ${findings.tokenInfo}`);

    // ── SDK notes ──
    findings.sdkNotes = [
      "Hand-rolled NDJSON transport works well with Bun.spawn (piped stdin/stdout).",
      "JSON-RPC 2.0 framing is straightforward — no special SDK needed for basic usage.",
      "@agentclientprotocol/sdk not tested in this spike — raw NDJSON proved sufficient.",
      "Bun ReadableStream.getReader() works for incremental NDJSON parsing.",
      "No Node.js compat shims required for the transport layer.",
    ].join("\n");
  } finally {
    // ── Teardown ──
    console.error("\n[spike] === Teardown ===");
    await transport.kill();
    console.error("[spike] Process killed");
  }

  return findings;
}

// Terminal result storage for the spike
const terminalResults = new Map<string, { stdout: string; stderr: string; exitCode: number }>();

// ── Main ──

async function main() {
  const config = parseArgs();
  console.error(`[spike] ACP Protocol Spike — agent=${config.agent}`);
  console.error(`[spike] Trace file: ${config.tracePath}`);

  const findings = await runSpike(config);

  // Print summary report
  console.error(`\n${"=".repeat(60)}`);
  console.error("ACP SPIKE FINDINGS SUMMARY");
  console.error("=".repeat(60));
  console.error(`Agent:              ${config.agent}`);
  console.error(`Handshake OK:       ${findings.handshakeOk}`);
  console.error(`Session created:    ${findings.sessionCreated} (id=${findings.sessionId})`);
  console.error(`Streaming working:  ${findings.promptStreaming}`);
  console.error(`Update types seen:  ${[...findings.updateTypes].join(", ") || "none"}`);
  console.error(`Permission format:  ${findings.permissionFormat ? "captured" : "not seen"}`);
  console.error(`Cancel worked:      ${findings.cancelWorked}`);
  console.error(`probe.txt created:  ${findings.probeFileCreated}`);
  console.error(`Token info:         ${findings.tokenInfo}`);
  console.error(`Trace file:         ${config.tracePath}`);
  console.error("=".repeat(60));

  if (findings.permissionFormat) {
    console.error("\nPermission request shape:");
    console.error(JSON.stringify(findings.permissionFormat, null, 2));
  }

  if (findings.capabilities) {
    console.error("\nAgent capabilities:");
    console.error(JSON.stringify(findings.capabilities, null, 2));
  }

  console.error("\nSDK Notes:");
  console.error(findings.sdkNotes);

  // Output structured results to stdout (JSON)
  const output = {
    agent: config.agent,
    handshakeOk: findings.handshakeOk,
    capabilities: findings.capabilities,
    sessionCreated: findings.sessionCreated,
    sessionId: findings.sessionId,
    promptStreaming: findings.promptStreaming,
    updateTypes: [...findings.updateTypes],
    permissionFormat: findings.permissionFormat,
    cancelWorked: findings.cancelWorked,
    probeFileCreated: findings.probeFileCreated,
    tokenInfo: findings.tokenInfo,
    sdkNotes: findings.sdkNotes,
    tracePath: config.tracePath,
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(`[spike] Fatal error: ${err}`);
  process.exit(1);
});
