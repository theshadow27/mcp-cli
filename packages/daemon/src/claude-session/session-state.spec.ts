import { describe, expect, test } from "bun:test";
import { type RequestIdGenerator, type SessionEvent, SessionState } from "./session-state";

// ── Test fixtures ──

const SYSTEM_INIT = {
  type: "system",
  subtype: "init",
  cwd: "/home/user/project",
  session_id: "sess-1",
  tools: ["Bash", "Read"],
  mcp_servers: [{ name: "github", status: "connected" }],
  model: "claude-sonnet-4-6",
  permissionMode: "default",
  apiKeySource: "subscription",
  claude_code_version: "2.1.70",
  uuid: "uuid-1",
};

const ASSISTANT_MSG = {
  type: "assistant",
  message: {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "Hello!" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
  },
  parent_tool_use_id: null,
  uuid: "uuid-2",
  session_id: "sess-1",
};

const RESULT_SUCCESS = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Done!",
  duration_ms: 5000,
  duration_api_ms: 4500,
  num_turns: 3,
  total_cost_usd: 0.05,
  usage: { input_tokens: 200, output_tokens: 100 },
  uuid: "uuid-3",
  session_id: "sess-1",
};

const RESULT_ERROR = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  errors: ["Tool execution failed"],
  duration_ms: 1000,
  num_turns: 1,
  total_cost_usd: 0.01,
  uuid: "uuid-4",
  session_id: "sess-1",
};

const CAN_USE_TOOL = {
  type: "control_request" as const,
  request_id: "req-1",
  request: {
    subtype: "can_use_tool" as const,
    tool_name: "Bash",
    input: { command: "rm -rf /" },
    tool_use_id: "tu-1",
  },
};

const CAN_USE_TOOL_2 = {
  type: "control_request" as const,
  request_id: "req-2",
  request: {
    subtype: "can_use_tool" as const,
    tool_name: "Write",
    input: { file_path: "/etc/passwd", content: "bad" },
    tool_use_id: "tu-2",
  },
};

// ── Helpers ──

function testIdGenerator(): RequestIdGenerator {
  let id = 1;
  return () => `mcpd-${id++}`;
}

function initSession(): SessionState {
  const session = new SessionState("sess-1", testIdGenerator());
  session.handleMessage(SYSTEM_INIT);
  return session;
}

function activeSession(): SessionState {
  const session = initSession();
  session.handleMessage(ASSISTANT_MSG);
  return session;
}

// ── Tests ──

describe("SessionState", () => {
  // -- Construction --

  test("starts in connecting state", () => {
    const session = new SessionState("sess-1");
    expect(session.state).toBe("connecting");
    expect(session.sessionId).toBe("sess-1");
    expect(session.model).toBeNull();
    expect(session.cwd).toBeNull();
    expect(session.cost).toBe(0);
    expect(session.tokens).toBe(0);
  });

  // -- system/init --

  describe("system/init", () => {
    test("transitions to init and extracts metadata", () => {
      const session = new SessionState("sess-1");
      const events = session.handleMessage(SYSTEM_INIT);

      expect(session.state).toBe("init");
      expect(session.model).toBe("claude-sonnet-4-6");
      expect(session.cwd).toBe("/home/user/project");
      expect(events).toEqual([
        {
          type: "session:init",
          sessionId: "sess-1",
          model: "claude-sonnet-4-6",
          cwd: "/home/user/project",
          state: "init",
        },
      ]);
    });

    test("does not regress state when CLI re-sends system/init after reconnect", () => {
      // Simulate: session completes work (idle), WS drops, CLI reconnects
      // and re-sends system/init — state should NOT regress to "init"
      const session = new SessionState("sess-1");
      session.handleMessage(SYSTEM_INIT);
      session.handleMessage(ASSISTANT_MSG);
      session.handleMessage(RESULT_SUCCESS);
      expect(session.state).toBe("idle");
      expect(session.cost).toBe(0.05);

      // CLI reconnects and re-sends system/init
      const events = session.handleMessage(SYSTEM_INIT);

      // State stays "idle" — no regression
      expect(session.state).toBe("idle");
      // Model/cwd still updated
      expect(session.model).toBe("claude-sonnet-4-6");
      expect(session.cwd).toBe("/home/user/project");
      // Event carries the actual state, not "init"
      expect(events[0].type).toBe("session:init");
      expect((events[0] as { state: string }).state).toBe("idle");
      // Cost preserved
      expect(session.cost).toBe(0.05);
    });

    test("transitions to init after reconnect (disconnected → connecting → init)", () => {
      // Simulate: session disconnects, reconnects, gets system/init
      const session = new SessionState("sess-1");
      session.handleMessage(SYSTEM_INIT);
      session.handleMessage(ASSISTANT_MSG);
      session.handleMessage(RESULT_SUCCESS);
      expect(session.state).toBe("idle");

      // WS drops → disconnected → reconnect → connecting
      session.disconnect("WS closed");
      expect(session.state).toBe("disconnected");
      session.reconnect();
      expect(session.state).toBe("connecting");

      // system/init should transition to "init" from "connecting"
      const events = session.handleMessage(SYSTEM_INIT);
      expect(session.state).toBe("init");
      expect((events[0] as { state: string }).state).toBe("init");
    });
  });

  // -- assistant --

  describe("assistant messages", () => {
    test("transitions to active and accumulates tokens", () => {
      const session = initSession();
      const events = session.handleMessage(ASSISTANT_MSG);

      expect(session.state).toBe("active");
      expect(session.tokens).toBe(150); // 100 + 50
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("session:response");
    });

    test("accumulates tokens across multiple assistant messages", () => {
      const session = initSession();
      session.handleMessage(ASSISTANT_MSG);
      session.handleMessage(ASSISTANT_MSG);

      expect(session.tokens).toBe(300); // 150 * 2
    });
  });

  // -- result --

  describe("result messages", () => {
    test("success transitions to idle and sets cumulative cost", () => {
      const session = activeSession();
      const events = session.handleMessage(RESULT_SUCCESS);

      expect(session.state).toBe("idle");
      expect(session.cost).toBe(0.05);
      expect(session.numTurns).toBe(3);
      // tokens = 150 from the assistant message; result usage is NOT added
      // (assistant messages already accumulate per-message tokens)
      expect(session.tokens).toBe(150);
      expect(events).toEqual([
        {
          type: "session:result",
          cost: 0.05,
          tokens: 150,
          numTurns: 3,
          result: "Done!",
        },
      ]);
    });

    test("error transitions to idle", () => {
      const session = activeSession();
      const events = session.handleMessage(RESULT_ERROR);

      expect(session.state).toBe("idle");
      expect(session.cost).toBe(0.01);
      expect(events).toEqual([
        {
          type: "session:error",
          errors: ["Tool execution failed"],
          cost: 0.01,
        },
      ]);
    });

    test("sets cumulative cost from SDK (not additive)", () => {
      const session = activeSession();
      session.handleMessage(RESULT_SUCCESS); // total_cost_usd=0.05, num_turns=3

      // Start a new turn — SDK sends higher cumulative values
      session.queuePrompt("Next task");
      session.handleMessage(ASSISTANT_MSG);
      session.handleMessage({
        ...RESULT_SUCCESS,
        total_cost_usd: 0.1,
        num_turns: 7,
      });

      // Cost/turns are SET to the cumulative value, not added
      expect(session.cost).toBe(0.1);
      expect(session.numTurns).toBe(7);
    });
  });

  // -- can_use_tool --

  describe("permission flow", () => {
    test("transitions to waiting_permission on can_use_tool", () => {
      const session = activeSession();
      const events = session.handleMessage(CAN_USE_TOOL);

      expect(session.state).toBe("waiting_permission");
      expect(session.pendingPermissions.size).toBe(1);
      expect(session.pendingPermissions.get("req-1")?.tool_name).toBe("Bash");
      expect(events).toEqual([
        {
          type: "session:permission_request",
          requestId: "req-1",
          request: CAN_USE_TOOL.request,
        },
      ]);
    });

    test("approve transitions back to active", () => {
      const session = activeSession();
      session.handleMessage(CAN_USE_TOOL);

      const response = session.respondToPermission("req-1", true);
      const parsed = JSON.parse(response);

      expect(session.state).toBe("active");
      expect(session.pendingPermissions.size).toBe(0);
      expect(parsed.response.response.behavior).toBe("allow");
      expect(parsed.response.response.updatedInput).toEqual({ command: "rm -rf /" });
    });

    test("deny transitions back to active", () => {
      const session = activeSession();
      session.handleMessage(CAN_USE_TOOL);

      const response = session.respondToPermission("req-1", false, "Too dangerous");
      const parsed = JSON.parse(response);

      expect(session.state).toBe("active");
      expect(parsed.response.response.behavior).toBe("deny");
      expect(parsed.response.response.message).toBe("Too dangerous");
    });

    test("deny uses default message when none provided", () => {
      const session = activeSession();
      session.handleMessage(CAN_USE_TOOL);

      const response = session.respondToPermission("req-1", false);
      const parsed = JSON.parse(response);
      expect(parsed.response.response.message).toBe("Denied by session controller");
    });

    test("multiple pending permissions", () => {
      const session = activeSession();
      session.handleMessage(CAN_USE_TOOL);
      session.handleMessage(CAN_USE_TOOL_2);

      expect(session.pendingPermissions.size).toBe(2);
      expect(session.state).toBe("waiting_permission");

      // Approve first — still waiting
      session.respondToPermission("req-1", true);
      expect(session.state).toBe("waiting_permission");
      expect(session.pendingPermissions.size).toBe(1);

      // Approve second — back to active
      session.respondToPermission("req-2", true);
      expect(session.state).toBe("active");
      expect(session.pendingPermissions.size).toBe(0);
    });

    test("throws on unknown request id", () => {
      const session = activeSession();
      expect(() => session.respondToPermission("unknown", true)).toThrow(
        "No pending permission request with id unknown",
      );
    });
  });

  // -- queuePrompt --

  describe("queuePrompt", () => {
    test("sends user message from idle state", () => {
      const session = activeSession();
      session.handleMessage(RESULT_SUCCESS);
      expect(session.state).toBe("idle");

      const msg = session.queuePrompt("Do something");
      const parsed = JSON.parse(msg);

      expect(session.state).toBe("active");
      expect(parsed.type).toBe("user");
      expect(parsed.message.content).toBe("Do something");
      expect(parsed.session_id).toBe("sess-1");
    });

    test("sends user message from init state", () => {
      const session = initSession();
      expect(session.state).toBe("init");

      session.queuePrompt("Hello");
      expect(session.state).toBe("active");
    });

    test("throws when waiting for permission", () => {
      const session = activeSession();
      session.handleMessage(CAN_USE_TOOL);

      expect(() => session.queuePrompt("Hello")).toThrow("Cannot send prompt while waiting for permission approval");
    });

    test("throws on ended session", () => {
      const session = new SessionState("sess-1");
      session.end();

      expect(() => session.queuePrompt("Hello")).toThrow("Cannot send prompt to ended session");
    });
  });

  // -- interrupt --

  describe("interrupt", () => {
    test("builds interrupt request", () => {
      const session = activeSession();
      const msg = session.interrupt();
      const parsed = JSON.parse(msg);

      expect(parsed.type).toBe("control_request");
      expect(parsed.request.subtype).toBe("interrupt");
      expect(parsed.request_id).toBe("mcpd-1");
    });

    test("uses default id generator when none injected", () => {
      const session = new SessionState("sess-1");
      session.handleMessage(SYSTEM_INIT);
      session.handleMessage(ASSISTANT_MSG);
      const msg = session.interrupt();
      const parsed = JSON.parse(msg);

      expect(parsed.request_id).toMatch(/^mcpd-\d+$/);
    });

    test("throws on ended session", () => {
      const session = new SessionState("sess-1");
      session.end();

      expect(() => session.interrupt()).toThrow("Cannot interrupt ended session");
    });
  });

  // -- end --

  describe("end", () => {
    test("transitions to ended and clears permissions", () => {
      const session = activeSession();
      session.handleMessage(CAN_USE_TOOL);
      expect(session.pendingPermissions.size).toBe(1);

      const events = session.end();

      expect(session.state).toBe("ended");
      expect(session.pendingPermissions.size).toBe(0);
      expect(events).toEqual([{ type: "session:ended" }]);
    });

    test("is idempotent", () => {
      const session = new SessionState("sess-1");
      session.end();
      const events = session.end();

      expect(session.state).toBe("ended");
      expect(events).toEqual([]);
    });
  });

  // -- Ignored messages --

  describe("ignored messages", () => {
    test.each([
      { type: "keep_alive" },
      { type: "stream_event", event: {}, parent_tool_use_id: null, uuid: "u", session_id: "s" },
      {
        type: "tool_progress",
        tool_use_id: "t",
        tool_name: "X",
        parent_tool_use_id: null,
        elapsed_time_seconds: 1,
        uuid: "u",
        session_id: "s",
      },
      { type: "tool_use_summary", summary: "s", preceding_tool_use_ids: [], uuid: "u", session_id: "s" },
      { type: "auth_status", isAuthenticating: false, output: [], uuid: "u", session_id: "s" },
      { type: "system", subtype: "status", status: null, uuid: "u", session_id: "s" },
    ])("ignores $type messages", (msg) => {
      const session = activeSession();
      const events = session.handleMessage(msg);
      expect(events).toEqual([]);
    });

    test("ignores unknown control_request subtypes", () => {
      const session = activeSession();
      const events = session.handleMessage({
        type: "control_request",
        request_id: "req-99",
        request: { subtype: "hook_callback", callback_id: "cb-1", input: {} },
      });
      expect(events).toEqual([]);
    });
  });

  // -- resetForClear --

  describe("resetForClear", () => {
    test("resets to connecting, preserves cost/tokens", () => {
      const session = activeSession();
      session.handleMessage(RESULT_SUCCESS);
      expect(session.state).toBe("idle");
      expect(session.cost).toBe(0.05);
      expect(session.tokens).toBeGreaterThan(0);

      const events = session.resetForClear();

      expect(session.state).toBe("connecting");
      expect(session.cost).toBe(0.05); // preserved
      expect(session.tokens).toBeGreaterThan(0); // preserved
      expect(events).toEqual([{ type: "session:cleared" }]);
    });

    test("clears pending permissions", () => {
      const session = activeSession();
      session.handleMessage(CAN_USE_TOOL);
      expect(session.pendingPermissions.size).toBe(1);

      session.resetForClear();

      expect(session.pendingPermissions.size).toBe(0);
    });

    test("no-op on ended session", () => {
      const session = new SessionState("sess-1");
      session.end();

      const events = session.resetForClear();
      expect(events).toEqual([]);
      expect(session.state).toBe("ended");
    });
  });

  // -- setModel --

  describe("setModel", () => {
    test("updates model and emits event", () => {
      const session = initSession();
      expect(session.model).toBe("claude-sonnet-4-6");

      const events = session.setModel("claude-opus-4-6");

      expect(session.model).toBe("claude-opus-4-6");
      expect(events).toEqual([{ type: "session:model_changed", model: "claude-opus-4-6" }]);
    });
  });

  // -- Full lifecycle --

  describe("full lifecycle", () => {
    test("init → prompt → response → permission → approve → result → idle → prompt → result → end", () => {
      const session = new SessionState("sess-1");
      const allEvents: SessionEvent[] = [];

      // 1. Init
      allEvents.push(...session.handleMessage(SYSTEM_INIT));
      expect(session.state).toBe("init");

      // 2. Server sends initial prompt (transitions init → active)
      session.queuePrompt("What files exist?");
      expect(session.state).toBe("active");

      // 3. Assistant responds
      allEvents.push(...session.handleMessage(ASSISTANT_MSG));
      expect(session.state).toBe("active");

      // 4. Tool permission needed
      allEvents.push(...session.handleMessage(CAN_USE_TOOL));
      expect(session.state).toBe("waiting_permission");

      // 5. Approve
      session.respondToPermission("req-1", true);
      expect(session.state).toBe("active");

      // 6. More assistant response
      allEvents.push(...session.handleMessage(ASSISTANT_MSG));

      // 7. Result
      allEvents.push(...session.handleMessage(RESULT_SUCCESS));
      expect(session.state).toBe("idle");

      // 8. New prompt
      session.queuePrompt("Now fix the bug");
      expect(session.state).toBe("active");

      // 9. Quick response + result (SDK sends higher cumulative values)
      allEvents.push(...session.handleMessage(ASSISTANT_MSG));
      allEvents.push(
        ...session.handleMessage({
          ...RESULT_SUCCESS,
          total_cost_usd: 0.1,
          num_turns: 7,
        }),
      );
      expect(session.state).toBe("idle");

      // 10. End
      allEvents.push(...session.end());
      expect(session.state).toBe("ended");

      // Verify session:init event carries state
      const initEvent = allEvents.find((e) => e.type === "session:init");
      expect(initEvent).toBeDefined();
      expect((initEvent as { state: string }).state).toBe("init");

      // Verify event stream
      const types = allEvents.map((e) => e.type);
      expect(types).toEqual([
        "session:init",
        "session:response",
        "session:permission_request",
        "session:response",
        "session:result",
        "session:response",
        "session:result",
        "session:ended",
      ]);

      // Verify cumulative stats (set from SDK, not additive)
      expect(session.cost).toBe(0.1);
      expect(session.numTurns).toBe(7);
    });
  });

  describe("result fallback (fixes #978)", () => {
    test("transitions to idle when result message is missing is_error and duration fields", () => {
      const session = new SessionState("test");
      session.handleMessage(SYSTEM_INIT);
      session.handleMessage(ASSISTANT_MSG);
      expect(session.state).toBe("active");

      // Result message without is_error, duration_ms, duration_api_ms, uuid
      const events = session.handleMessage({
        type: "result",
        subtype: "success",
        result: "Done!",
        num_turns: 2,
        total_cost_usd: 0.03,
        usage: { input_tokens: 150, output_tokens: 75 },
        session_id: "sess-1",
      });

      expect(session.state).toBe("idle");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("session:result");
      if (events[0].type === "session:result") {
        expect(events[0].cost).toBe(0.03);
        expect(events[0].numTurns).toBe(2);
        // tokens = 150 from the assistant message only (result usage not added)
        expect(events[0].tokens).toBe(150);
      }
    });

    test("transitions to idle via fallback when result has unrecognized schema", () => {
      const session = new SessionState("test");
      session.handleMessage(SYSTEM_INIT);
      session.handleMessage(ASSISTANT_MSG);
      expect(session.state).toBe("active");

      // Result with completely different field names — only type: "result" matches
      const events = session.handleMessage({
        type: "result",
        subtype: "success",
        result: "All done",
        // Missing: is_error, num_turns, total_cost_usd, usage, duration_ms, etc.
        session_id: "sess-1",
      });

      expect(session.state).toBe("idle");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("session:result");
      if (events[0].type === "session:result") {
        // Fallback defaults for missing fields — cost/turns stay at 0 (no SDK data)
        // tokens = 150 from the assistant message (cumulative)
        expect(events[0].cost).toBe(0);
        expect(events[0].numTurns).toBe(0);
        expect(events[0].tokens).toBe(150);
        expect(events[0].result).toBe("All done");
      }
    });

    test("fallback handles error result with unrecognized schema", () => {
      const session = new SessionState("test");
      session.handleMessage(SYSTEM_INIT);
      session.handleMessage(ASSISTANT_MSG);

      const events = session.handleMessage({
        type: "result",
        subtype: "error",
        errors: ["Something went wrong"],
        session_id: "sess-1",
      });

      expect(session.state).toBe("idle");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("session:error");
      if (events[0].type === "session:error") {
        expect(events[0].errors).toEqual(["Something went wrong"]);
        expect(events[0].cost).toBe(0);
      }
    });

    test("strict schemas still match when all fields are present", () => {
      const session = new SessionState("test");
      session.handleMessage(SYSTEM_INIT);
      session.handleMessage(ASSISTANT_MSG);

      const events = session.handleMessage(RESULT_SUCCESS);

      expect(session.state).toBe("idle");
      expect(session.parseMismatch).toBe(false);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("session:result");
      if (events[0].type === "session:result") {
        expect(events[0].cost).toBe(0.05);
        expect(events[0].numTurns).toBe(3);
        // tokens = 150 from assistant message only (result usage not added)
        expect(events[0].tokens).toBe(150);
      }
    });

    test("sets parseMismatch when fallback is used for result", () => {
      const session = new SessionState("test");
      session.handleMessage(SYSTEM_INIT);
      session.handleMessage(ASSISTANT_MSG);

      session.handleMessage({
        type: "result",
        subtype: "success",
        result: "ok",
        session_id: "sess-1",
      });

      expect(session.parseMismatch).toBe(true);
      expect(session.state).toBe("idle");
    });
  });

  describe("init fallback", () => {
    test("transitions to init when system/init is missing non-essential fields", () => {
      const session = new SessionState("test");

      // Minimal init — only the fields the state machine truly needs
      const events = session.handleMessage({
        type: "system",
        subtype: "init",
        cwd: "/project",
        session_id: "sess-99",
        model: "claude-opus-4-6",
        // Missing: tools, mcp_servers, permissionMode, apiKeySource,
        // claude_code_version, uuid
      });

      expect(session.state).toBe("init");
      expect(session.model).toBe("claude-opus-4-6");
      expect(session.cwd).toBe("/project");
      expect(session.parseMismatch).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("session:init");
      if (events[0].type === "session:init") {
        expect(events[0].sessionId).toBe("sess-99");
        expect(events[0].model).toBe("claude-opus-4-6");
        expect(events[0].cwd).toBe("/project");
      }
    });

    test("transitions to init with defaults when nearly all fields are missing", () => {
      const session = new SessionState("test");

      const events = session.handleMessage({
        type: "system",
        subtype: "init",
        // Missing: cwd, session_id, model, and everything else
      });

      expect(session.state).toBe("init");
      expect(session.parseMismatch).toBe(true);
      // Falls back to defaults
      expect(session.model).toBe("unknown");
      expect(session.cwd).toBe("/");
      expect(events).toHaveLength(1);
      if (events[0].type === "session:init") {
        expect(events[0].sessionId).toBe("test"); // falls back to SessionState.sessionId
        expect(events[0].model).toBe("unknown");
      }
    });

    test("strict schema still matches when all fields are present", () => {
      const session = new SessionState("test");
      session.handleMessage(SYSTEM_INIT);

      expect(session.state).toBe("init");
      expect(session.parseMismatch).toBe(false);
      expect(session.model).toBe("claude-sonnet-4-6");
      expect(session.cwd).toBe("/home/user/project");
    });
  });

  describe("assistant fallback", () => {
    test("transitions to active when assistant message is missing non-essential fields", () => {
      const session = new SessionState("test");
      session.handleMessage(SYSTEM_INIT);

      const events = session.handleMessage({
        type: "assistant",
        message: {
          // Only has usage — missing id, type, role, model, content, stop_reason
          usage: { input_tokens: 50, output_tokens: 25 },
        },
      });

      expect(session.state).toBe("active");
      expect(session.parseMismatch).toBe(true);
      expect(session.tokens).toBe(75);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("session:response");

      // Verify fallback constructs a safe AssistantMsg with required fields
      const resp = events[0] as { type: string; message: Record<string, unknown> };
      expect(resp.message.type).toBe("assistant");
      expect(resp.message.session_id).toBe("unknown");
      const innerMsg = resp.message.message as Record<string, unknown>;
      expect(innerMsg.role).toBe("assistant");
      expect(innerMsg.usage).toEqual({ input_tokens: 50, output_tokens: 25 });
    });

    test("transitions to active with zero tokens when usage is missing", () => {
      const session = new SessionState("test");
      session.handleMessage(SYSTEM_INIT);

      const events = session.handleMessage({
        type: "assistant",
        // Completely missing message or usage
      });

      expect(session.state).toBe("active");
      expect(session.parseMismatch).toBe(true);
      expect(session.tokens).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("session:response");

      // Verify fallback fills safe defaults for all required fields
      const resp = events[0] as { type: string; message: Record<string, unknown> };
      const innerMsg = resp.message.message as Record<string, unknown>;
      expect(innerMsg.role).toBe("assistant");
      expect(innerMsg.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
      expect(innerMsg.content).toEqual([]);
    });

    test("strict schema still matches when all fields are present", () => {
      const session = new SessionState("test");
      session.handleMessage(SYSTEM_INIT);

      session.handleMessage(ASSISTANT_MSG);

      expect(session.state).toBe("active");
      expect(session.parseMismatch).toBe(false);
      expect(session.tokens).toBe(150);
    });
  });

  describe("control_request fallback", () => {
    test("sets parseMismatch when can_use_tool message fails to parse", () => {
      const session = new SessionState("test");
      session.handleMessage(SYSTEM_INIT);
      session.handleMessage(ASSISTANT_MSG);

      const events = session.handleMessage({
        type: "control_request",
        request_id: "req-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          // Missing: input, tool_use_id
        },
      });

      expect(events).toHaveLength(0);
      expect(session.parseMismatch).toBe(true);
      // State should NOT change — we couldn't extract enough to create a permission entry
      expect(session.state).toBe("active");
    });

    test("does not set parseMismatch for non-can_use_tool control requests", () => {
      const session = new SessionState("test");
      session.handleMessage(SYSTEM_INIT);

      const events = session.handleMessage({
        type: "control_request",
        request_id: "req-1",
        request: { subtype: "hook_callback", callback_id: "cb-1", input: {} },
      });

      expect(events).toHaveLength(0);
      expect(session.parseMismatch).toBe(false);
    });
  });

  describe("rate limiting", () => {
    const ASSISTANT_RATE_LIMITED = {
      ...ASSISTANT_MSG,
      error: "rate_limit",
    };

    test("emits session:rate_limited when assistant has error: rate_limit", () => {
      const session = initSession();
      const events = session.handleMessage(ASSISTANT_RATE_LIMITED);

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("session:response");
      expect(events[1]).toEqual({ type: "session:rate_limited", sessionId: "sess-1" });
      expect(session.rateLimited).toBe(true);
    });

    test("does not emit session:rate_limited for normal assistant messages", () => {
      const session = initSession();
      const events = session.handleMessage(ASSISTANT_MSG);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("session:response");
      expect(session.rateLimited).toBe(false);
    });

    test("clears rateLimited on successful result", () => {
      const session = initSession();
      session.handleMessage(ASSISTANT_RATE_LIMITED);
      expect(session.rateLimited).toBe(true);

      session.handleMessage(RESULT_SUCCESS);
      expect(session.rateLimited).toBe(false);
    });

    test("rateLimited flag persists across multiple assistant messages", () => {
      const session = initSession();
      session.handleMessage(ASSISTANT_RATE_LIMITED);
      expect(session.rateLimited).toBe(true);

      // A normal assistant message does not clear the flag
      session.handleMessage(ASSISTANT_MSG);
      expect(session.rateLimited).toBe(true);
    });

    test("rate limit detected in fallback assistant messages", () => {
      const session = new SessionState("test-rl");
      session.handleMessage(SYSTEM_INIT);
      const events = session.handleMessage({
        type: "assistant",
        error: "rate_limit",
        message: {
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      });

      expect(session.rateLimited).toBe(true);
      expect(session.parseMismatch).toBe(true);
      expect(events).toHaveLength(2);
      expect(events[1]).toEqual({ type: "session:rate_limited", sessionId: "test-rl" });
    });
  });

  describe("parseMismatch lifecycle", () => {
    test("parseMismatch is cleared on each handleMessage call", () => {
      const session = new SessionState("test");

      // Trigger a fallback
      session.handleMessage({
        type: "system",
        subtype: "init",
        cwd: "/test",
        session_id: "s1",
        model: "test",
      });
      expect(session.parseMismatch).toBe(true);

      // Next message should clear it
      session.handleMessage({
        type: "keep_alive",
      });
      expect(session.parseMismatch).toBe(false);
    });
  });
});
