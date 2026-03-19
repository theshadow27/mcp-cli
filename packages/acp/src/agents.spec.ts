import { describe, expect, test } from "bun:test";
import { AGENTS, resolveAgentCommand } from "./agents";

describe("AGENTS registry", () => {
  test("copilot uses gh copilot --acp", () => {
    const agent = AGENTS.copilot;
    expect(agent.command).toBe("gh");
    expect(agent.args).toEqual(["copilot", "--acp"]);
  });

  test("gemini uses gemini --acp", () => {
    const agent = AGENTS.gemini;
    expect(agent.command).toBe("gemini");
    expect(agent.args).toEqual(["--acp"]);
  });
});

describe("resolveAgentCommand", () => {
  test("known agent returns registry command", () => {
    const result = resolveAgentCommand("copilot");
    expect(result.command).toEqual(["gh", "copilot", "--acp"]);
    expect(result.displayName).toBe("GitHub Copilot");
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
