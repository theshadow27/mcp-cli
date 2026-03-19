import { describe, expect, test } from "bun:test";
import { ACP_AGENTS, resolveAgentCommand } from "./agents";

describe("ACP_AGENTS registry", () => {
  test("copilot uses standalone copilot binary with --acp", () => {
    const agent = ACP_AGENTS.copilot;
    expect(agent.command).toBe("copilot");
    expect(agent.args).toEqual(["--acp"]);
    expect(agent.installHint).toContain("gh extension install");
  });

  test("gemini uses gemini --acp", () => {
    const agent = ACP_AGENTS.gemini;
    expect(agent.command).toBe("gemini");
    expect(agent.args).toEqual(["--acp"]);
    expect(agent.installHint).toContain("npm install");
    expect(agent.installHint).toContain("@google/gemini-cli");
    expect(agent.installHint).not.toContain("@anthropic-ai/gemini-cli");
  });
});

describe("resolveAgentCommand", () => {
  test("known agent returns registry command", () => {
    const result = resolveAgentCommand("copilot");
    expect(result.command).toEqual(["copilot", "--acp"]);
    expect(result.displayName).toBe("copilot");
  });

  test("custom command overrides agent name", () => {
    const result = resolveAgentCommand("copilot", ["/usr/local/bin/my-agent", "--acp"]);
    expect(result.command).toEqual(["/usr/local/bin/my-agent", "--acp"]);
    expect(result.displayName).toContain("custom");
  });

  test("unknown agent falls back to name --acp", () => {
    const result = resolveAgentCommand("some-new-agent");
    expect(result.command).toEqual(["some-new-agent", "--acp"]);
    expect(result.displayName).toBe("some-new-agent");
  });

  test("empty custom command uses agent name", () => {
    const result = resolveAgentCommand("gemini", []);
    expect(result.command).toEqual(["gemini", "--acp"]);
  });
});
