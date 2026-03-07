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
        },
      ]);
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
    test("success transitions to idle and accumulates cost", () => {
      const session = activeSession();
      const events = session.handleMessage(RESULT_SUCCESS);

      expect(session.state).toBe("idle");
      expect(session.cost).toBe(0.05);
      expect(session.numTurns).toBe(3);
      expect(events).toEqual([
        {
          type: "session:result",
          cost: 0.05,
          tokens: 300,
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

    test("accumulates cost across multiple turns", () => {
      const session = activeSession();
      session.handleMessage(RESULT_SUCCESS);

      // Start a new turn
      session.queuePrompt("Next task");
      session.handleMessage(ASSISTANT_MSG);
      session.handleMessage(RESULT_SUCCESS);

      expect(session.cost).toBe(0.1);
      expect(session.numTurns).toBe(6);
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

      // 9. Quick response + result
      allEvents.push(...session.handleMessage(ASSISTANT_MSG));
      allEvents.push(...session.handleMessage(RESULT_SUCCESS));
      expect(session.state).toBe("idle");

      // 10. End
      allEvents.push(...session.end());
      expect(session.state).toBe("ended");

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

      // Verify accumulated stats
      expect(session.cost).toBe(0.1);
      expect(session.numTurns).toBe(6);
    });
  });
});
