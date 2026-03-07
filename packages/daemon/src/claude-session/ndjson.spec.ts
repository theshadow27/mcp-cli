import { describe, expect, test } from "bun:test";
import {
  Assistant,
  CanUseTool,
  KeepAlive,
  ResultError,
  ResultSuccess,
  SystemInit,
  ToolProgress,
  controlResponseError,
  controlResponseSuccess,
  initializeRequest,
  interruptRequest,
  keepAlive,
  parseFrame,
  parseLine,
  permissionAllow,
  permissionDeny,
  serialize,
  userMessage,
} from "./ndjson";

// ── parseLine ──

describe("parseLine", () => {
  test("parses a valid NDJSON line", () => {
    const msg = parseLine('{"type":"keep_alive"}');
    expect(msg.type).toBe("keep_alive");
  });

  test("trims whitespace", () => {
    const msg = parseLine('  {"type":"keep_alive"}  \n');
    expect(msg.type).toBe("keep_alive");
  });

  test("preserves extra fields (passthrough)", () => {
    const msg = parseLine('{"type":"system","subtype":"init","cwd":"/tmp"}');
    expect(msg.type).toBe("system");
    expect(msg.subtype).toBe("init");
    expect(msg.cwd).toBe("/tmp");
  });

  test("throws on empty string", () => {
    expect(() => parseLine("")).toThrow("Empty NDJSON line");
  });

  test("throws on whitespace-only string", () => {
    expect(() => parseLine("   ")).toThrow("Empty NDJSON line");
  });

  test("throws on invalid JSON", () => {
    expect(() => parseLine("{not json}")).toThrow();
  });

  test("throws on JSON without type field", () => {
    expect(() => parseLine('{"foo":"bar"}')).toThrow();
  });

  test("throws on non-string type field", () => {
    expect(() => parseLine('{"type":42}')).toThrow();
  });
});

// ── parseFrame ──

describe("parseFrame", () => {
  test("parses multiple lines in one frame", () => {
    const frame = '{"type":"keep_alive"}\n{"type":"assistant","uuid":"a"}\n';
    const msgs = parseFrame(frame);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].type).toBe("keep_alive");
    expect(msgs[1].type).toBe("assistant");
  });

  test("handles single line without trailing newline", () => {
    const msgs = parseFrame('{"type":"keep_alive"}');
    expect(msgs).toHaveLength(1);
  });

  test("skips empty lines", () => {
    const frame = '{"type":"keep_alive"}\n\n{"type":"result"}\n\n';
    const msgs = parseFrame(frame);
    expect(msgs).toHaveLength(2);
  });

  test("returns empty array for empty frame", () => {
    expect(parseFrame("")).toEqual([]);
    expect(parseFrame("\n\n")).toEqual([]);
  });
});

// ── Schema validation ──

describe("SystemInit schema", () => {
  const validInit = {
    type: "system",
    subtype: "init",
    cwd: "/home/user/project",
    session_id: "abc-123",
    tools: ["Bash", "Read", "Write"],
    mcp_servers: [{ name: "github", status: "connected" }],
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    apiKeySource: "subscription",
    claude_code_version: "2.1.70",
    uuid: "uuid-1",
    slash_commands: ["/help"],
    output_style: "json",
  };

  test("parses valid system/init", () => {
    const result = SystemInit.parse(validInit);
    expect(result.session_id).toBe("abc-123");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.tools).toEqual(["Bash", "Read", "Write"]);
  });

  test("preserves extra fields via passthrough", () => {
    const result = SystemInit.parse(validInit);
    expect((result as Record<string, unknown>).slash_commands).toEqual(["/help"]);
  });

  test("rejects wrong subtype", () => {
    expect(() => SystemInit.parse({ ...validInit, subtype: "status" })).toThrow();
  });
});

describe("Assistant schema", () => {
  const validAssistant = {
    type: "assistant",
    message: {
      id: "msg_01",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    uuid: "uuid-2",
    session_id: "abc-123",
  };

  test("parses valid assistant message", () => {
    const result = Assistant.parse(validAssistant);
    expect(result.message.model).toBe("claude-sonnet-4-6");
    expect(result.message.usage.input_tokens).toBe(100);
  });

  test("allows optional error field", () => {
    const withError = { ...validAssistant, error: "rate_limit" };
    const result = Assistant.parse(withError);
    expect(result.error).toBe("rate_limit");
  });

  test("allows cache fields to be absent", () => {
    const noCache = {
      ...validAssistant,
      message: {
        ...validAssistant.message,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
    const result = Assistant.parse(noCache);
    expect(result.message.usage.cache_creation_input_tokens).toBeUndefined();
  });
});

describe("Result schemas", () => {
  const validSuccess = {
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
    session_id: "abc-123",
  };

  test("parses success result", () => {
    const result = ResultSuccess.parse(validSuccess);
    expect(result.total_cost_usd).toBe(0.05);
    expect(result.num_turns).toBe(3);
  });

  test("preserves extra fields (modelUsage etc.)", () => {
    const extended = { ...validSuccess, modelUsage: { "claude-sonnet": { costUSD: 0.05 } } };
    const result = ResultSuccess.parse(extended);
    expect((result as Record<string, unknown>).modelUsage).toBeDefined();
  });

  const validError = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["Tool execution failed"],
    duration_ms: 1000,
    num_turns: 1,
    total_cost_usd: 0.01,
    uuid: "uuid-4",
    session_id: "abc-123",
  };

  test("parses error result", () => {
    const result = ResultError.parse(validError);
    expect(result.errors).toEqual(["Tool execution failed"]);
  });

  test("accepts all error subtypes", () => {
    for (const subtype of ["error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"]) {
      const result = ResultError.parse({ ...validError, subtype });
      expect(result.subtype).toBe(subtype);
    }
  });
});

describe("CanUseTool schema", () => {
  const validCanUseTool = {
    type: "control_request",
    request_id: "req-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "ls -la" },
      tool_use_id: "tu-1",
    },
  };

  test("parses valid can_use_tool", () => {
    const result = CanUseTool.parse(validCanUseTool);
    expect(result.request.tool_name).toBe("Bash");
    expect(result.request.input).toEqual({ command: "ls -la" });
  });

  test("allows optional fields", () => {
    const extended = {
      ...validCanUseTool,
      request: {
        ...validCanUseTool.request,
        description: "List files",
        agent_id: "agent-1",
        decision_reason: "other",
        blocked_path: "/etc/passwd",
      },
    };
    const result = CanUseTool.parse(extended);
    expect(result.request.description).toBe("List files");
    expect(result.request.agent_id).toBe("agent-1");
  });
});

describe("ToolProgress schema", () => {
  test("parses valid tool_progress", () => {
    const result = ToolProgress.parse({
      type: "tool_progress",
      tool_use_id: "tu-1",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 5.2,
      uuid: "uuid-5",
      session_id: "abc-123",
    });
    expect(result.tool_name).toBe("Bash");
    expect(result.elapsed_time_seconds).toBe(5.2);
  });
});

describe("KeepAlive schema", () => {
  test("parses keep_alive", () => {
    const result = KeepAlive.parse({ type: "keep_alive" });
    expect(result.type).toBe("keep_alive");
  });
});

// ── Serialization ──

describe("serialize", () => {
  test("produces JSON followed by newline", () => {
    const line = serialize({ type: "keep_alive" });
    expect(line).toBe('{"type":"keep_alive"}\n');
  });
});

describe("userMessage", () => {
  test("builds simple text message", () => {
    const line = userMessage("Hello", "sess-1");
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe("user");
    expect(parsed.message.role).toBe("user");
    expect(parsed.message.content).toBe("Hello");
    expect(parsed.parent_tool_use_id).toBeNull();
    expect(parsed.session_id).toBe("sess-1");
  });

  test("builds message with content blocks", () => {
    const blocks = [{ type: "text", text: "Hello" }];
    const parsed = JSON.parse(userMessage(blocks, "sess-1"));
    expect(parsed.message.content).toEqual(blocks);
  });

  test("includes optional fields when provided", () => {
    const parsed = JSON.parse(
      userMessage("Hi", "sess-1", {
        parentToolUseId: "tu-1",
        uuid: "uuid-6",
      }),
    );
    expect(parsed.parent_tool_use_id).toBe("tu-1");
    expect(parsed.uuid).toBe("uuid-6");
  });

  test("omits uuid when not provided", () => {
    const parsed = JSON.parse(userMessage("Hi", "sess-1"));
    expect(parsed.uuid).toBeUndefined();
  });
});

describe("controlResponseSuccess", () => {
  test("builds success response without payload", () => {
    const parsed = JSON.parse(controlResponseSuccess("req-1"));
    expect(parsed.type).toBe("control_response");
    expect(parsed.response.subtype).toBe("success");
    expect(parsed.response.request_id).toBe("req-1");
    expect(parsed.response.response).toBeUndefined();
  });

  test("builds success response with payload", () => {
    const parsed = JSON.parse(controlResponseSuccess("req-1", { mode: "default" }));
    expect(parsed.response.response).toEqual({ mode: "default" });
  });
});

describe("controlResponseError", () => {
  test("builds error response", () => {
    const parsed = JSON.parse(controlResponseError("req-1", "Something went wrong"));
    expect(parsed.type).toBe("control_response");
    expect(parsed.response.subtype).toBe("error");
    expect(parsed.response.request_id).toBe("req-1");
    expect(parsed.response.error).toBe("Something went wrong");
  });
});

describe("permissionAllow", () => {
  test("builds allow response", () => {
    const parsed = JSON.parse(permissionAllow("req-1", { command: "echo hi" }));
    expect(parsed.response.response.behavior).toBe("allow");
    expect(parsed.response.response.updatedInput).toEqual({ command: "echo hi" });
  });

  test("includes updatedPermissions when provided", () => {
    const perms = [{ type: "addRules", rules: [], behavior: "allow", destination: "session" }];
    const parsed = JSON.parse(permissionAllow("req-1", {}, perms));
    expect(parsed.response.response.updatedPermissions).toEqual(perms);
  });

  test("omits updatedPermissions when not provided", () => {
    const parsed = JSON.parse(permissionAllow("req-1", {}));
    expect(parsed.response.response.updatedPermissions).toBeUndefined();
  });
});

describe("permissionDeny", () => {
  test("builds deny response", () => {
    const parsed = JSON.parse(permissionDeny("req-1", "Not allowed"));
    expect(parsed.response.response.behavior).toBe("deny");
    expect(parsed.response.response.message).toBe("Not allowed");
  });

  test("includes interrupt flag", () => {
    const parsed = JSON.parse(permissionDeny("req-1", "Abort", true));
    expect(parsed.response.response.interrupt).toBe(true);
  });

  test("omits interrupt when undefined", () => {
    const parsed = JSON.parse(permissionDeny("req-1", "No"));
    expect(parsed.response.response.interrupt).toBeUndefined();
  });
});

describe("initializeRequest", () => {
  test("builds minimal initialize", () => {
    const parsed = JSON.parse(initializeRequest("req-1"));
    expect(parsed.type).toBe("control_request");
    expect(parsed.request_id).toBe("req-1");
    expect(parsed.request.subtype).toBe("initialize");
  });

  test("includes optional fields", () => {
    const parsed = JSON.parse(
      initializeRequest("req-1", {
        systemPrompt: "You are a helper",
        sdkMcpServers: ["github"],
      }),
    );
    expect(parsed.request.systemPrompt).toBe("You are a helper");
    expect(parsed.request.sdkMcpServers).toEqual(["github"]);
  });
});

describe("interruptRequest", () => {
  test("builds interrupt request", () => {
    const parsed = JSON.parse(interruptRequest("req-1"));
    expect(parsed.type).toBe("control_request");
    expect(parsed.request.subtype).toBe("interrupt");
  });
});

describe("keepAlive", () => {
  test("builds keep_alive", () => {
    const parsed = JSON.parse(keepAlive());
    expect(parsed.type).toBe("keep_alive");
  });
});

// ── Round-trip ──

describe("round-trip", () => {
  test("serialize → parseLine preserves message", () => {
    const original = {
      type: "user",
      message: { role: "user", content: "Hello" },
      parent_tool_use_id: null,
      session_id: "s1",
    };
    const line = serialize(original);
    const parsed = parseLine(line);
    expect(parsed).toEqual(original);
  });

  test("userMessage → parseLine → schema validation", () => {
    const line = userMessage("Test prompt", "sess-1");
    const msg = parseLine(line);
    expect(msg.type).toBe("user");
    // Validate with outbound schema (minus the trailing newline parse already strips)
    const { UserMessage } = require("./ndjson");
    expect(() => UserMessage.parse(msg)).not.toThrow();
  });
});
