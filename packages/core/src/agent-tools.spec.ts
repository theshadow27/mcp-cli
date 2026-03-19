import { describe, expect, test } from "bun:test";
import {
  AGENT_TOOL_NAMES,
  type AgentToolDef,
  type BuildAgentToolsOptions,
  buildAgentTools,
  prefixedToolName,
} from "./agent-tools";

/** Find a tool by name, failing the test if not found. */
function findTool(tools: readonly AgentToolDef[], name: string): AgentToolDef {
  const tool = tools.find((t) => t.name === name);
  expect(tool).toBeDefined();
  return tool as AgentToolDef;
}

describe("AGENT_TOOL_NAMES", () => {
  test("contains the 9 common tool basenames", () => {
    expect(AGENT_TOOL_NAMES).toEqual([
      "prompt",
      "session_list",
      "session_status",
      "interrupt",
      "bye",
      "transcript",
      "wait",
      "approve",
      "deny",
    ]);
  });
});

describe("buildAgentTools", () => {
  const minimal: BuildAgentToolsOptions = {
    prefix: "test",
    label: "Test Agent",
  };

  test("produces one tool per common basename", () => {
    const tools = buildAgentTools(minimal);
    expect(tools.length).toBe(AGENT_TOOL_NAMES.length);
    for (const basename of AGENT_TOOL_NAMES) {
      expect(tools.find((t) => t.name === `test_${basename}`)).toBeDefined();
    }
  });

  test("all tools have valid inputSchema with type 'object'", () => {
    const tools = buildAgentTools(minimal);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  test("prompt tool requires 'prompt' field", () => {
    const tools = buildAgentTools(minimal);
    const prompt = findTool(tools, "test_prompt");
    expect(prompt.inputSchema.required).toContain("prompt");
    expect(prompt.inputSchema.properties.prompt).toBeDefined();
  });

  test("session_status/interrupt/bye/transcript require sessionId", () => {
    const tools = buildAgentTools(minimal);
    for (const basename of ["session_status", "interrupt", "bye", "transcript"] as const) {
      const tool = findTool(tools, `test_${basename}`);
      expect(tool.inputSchema.required).toContain("sessionId");
    }
  });

  test("approve and deny require sessionId + requestId", () => {
    const tools = buildAgentTools(minimal);
    for (const basename of ["approve", "deny"] as const) {
      const tool = findTool(tools, `test_${basename}`);
      expect(tool.inputSchema.required).toContain("sessionId");
      expect(tool.inputSchema.required).toContain("requestId");
    }
  });

  test("session_list and wait do not require any fields", () => {
    const tools = buildAgentTools(minimal);
    for (const basename of ["session_list", "wait"] as const) {
      const tool = findTool(tools, `test_${basename}`);
      expect(tool.inputSchema.required).toBeUndefined();
    }
  });

  test("label appears in default descriptions", () => {
    const tools = buildAgentTools(minimal);
    const prompt = findTool(tools, "test_prompt");
    expect(prompt.description).toContain("Test Agent");
  });

  test("overrides replace description", () => {
    const tools = buildAgentTools({
      ...minimal,
      overrides: {
        prompt: { description: "Custom prompt description" },
      },
    });
    const prompt = findTool(tools, "test_prompt");
    expect(prompt.description).toBe("Custom prompt description");
  });

  test("overrides add extra properties", () => {
    const tools = buildAgentTools({
      ...minimal,
      overrides: {
        prompt: {
          extraProperties: {
            sandbox: { type: "string", enum: ["read-only", "full"], description: "Sandbox mode" },
          },
        },
      },
    });
    const prompt = findTool(tools, "test_prompt");
    expect(prompt.inputSchema.properties.sandbox).toBeDefined();
    expect(prompt.inputSchema.properties.sandbox.enum).toEqual(["read-only", "full"]);
    // Common properties still present
    expect(prompt.inputSchema.properties.prompt).toBeDefined();
    expect(prompt.inputSchema.properties.cwd).toBeDefined();
  });

  test("extraTools appends provider-specific tools", () => {
    const tools = buildAgentTools({
      ...minimal,
      extraTools: [
        {
          basename: "plans",
          description: "Get all plans",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    });
    expect(tools.length).toBe(AGENT_TOOL_NAMES.length + 1);
    const plans = findTool(tools, "test_plans");
    expect(plans.description).toBe("Get all plans");
  });

  test("different prefixes produce different tool names", () => {
    const claude = buildAgentTools({ prefix: "claude", label: "Claude" });
    const codex = buildAgentTools({ prefix: "codex", label: "Codex" });
    const claudeNames = claude.map((t) => t.name);
    const codexNames = codex.map((t) => t.name);
    for (const name of claudeNames) {
      expect(codexNames).not.toContain(name);
    }
  });
});

describe("prefixedToolName", () => {
  test("joins prefix and basename with underscore", () => {
    expect(prefixedToolName("claude", "prompt")).toBe("claude_prompt");
    expect(prefixedToolName("acp", "session_list")).toBe("acp_session_list");
  });
});

describe("provider tool arrays match expected structure", () => {
  test("claude tools include plans extra tool", async () => {
    const { CLAUDE_TOOLS } = await import("../../daemon/src/claude-session/tools");
    expect(CLAUDE_TOOLS.length).toBe(AGENT_TOOL_NAMES.length + 1);
    expect(CLAUDE_TOOLS.find((t: AgentToolDef) => t.name === "claude_plans")).toBeDefined();
  });

  test("codex tools match common set exactly", async () => {
    const { CODEX_TOOLS } = await import("../../daemon/src/codex-session/tools");
    expect(CODEX_TOOLS.length).toBe(AGENT_TOOL_NAMES.length);
    for (const basename of AGENT_TOOL_NAMES) {
      expect(CODEX_TOOLS.find((t: AgentToolDef) => t.name === `codex_${basename}`)).toBeDefined();
    }
  });

  test("acp tools match common set exactly", async () => {
    const { ACP_TOOLS } = await import("../../daemon/src/acp-session/tools");
    expect(ACP_TOOLS.length).toBe(AGENT_TOOL_NAMES.length);
    for (const basename of AGENT_TOOL_NAMES) {
      expect(ACP_TOOLS.find((t: AgentToolDef) => t.name === `acp_${basename}`)).toBeDefined();
    }
  });

  test("claude prompt has claude-specific properties", async () => {
    const { CLAUDE_TOOLS } = await import("../../daemon/src/claude-session/tools");
    const prompt = findTool(CLAUDE_TOOLS, "claude_prompt");
    expect(prompt.inputSchema.properties.permissionMode).toBeDefined();
    expect(prompt.inputSchema.properties.resumeSessionId).toBeDefined();
    expect(prompt.inputSchema.properties.repoRoot).toBeDefined();
  });

  test("codex prompt has codex-specific properties", async () => {
    const { CODEX_TOOLS } = await import("../../daemon/src/codex-session/tools");
    const prompt = findTool(CODEX_TOOLS, "codex_prompt");
    expect(prompt.inputSchema.properties.approvalPolicy).toBeDefined();
    expect(prompt.inputSchema.properties.sandbox).toBeDefined();
    expect(prompt.inputSchema.properties.disallowedTools).toBeDefined();
  });

  test("acp prompt has acp-specific properties", async () => {
    const { ACP_TOOLS } = await import("../../daemon/src/acp-session/tools");
    const prompt = findTool(ACP_TOOLS, "acp_prompt");
    expect(prompt.inputSchema.properties.agent).toBeDefined();
    expect(prompt.inputSchema.properties.customCommand).toBeDefined();
    expect(prompt.inputSchema.properties.disallowedTools).toBeDefined();
  });
});
