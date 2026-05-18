import { describe, expect, it } from "bun:test";

import { detectContext } from "./context";

describe("detectContext", () => {
  it("returns 'ai' when CLAUDECODE is set", () => {
    expect(detectContext({ CLAUDECODE: "1" })).toBe("ai");
  });

  it("returns 'ai' when AGENT is set", () => {
    expect(detectContext({ AGENT: "claude" })).toBe("ai");
  });

  it("returns 'ai' when MCP_CLI_AI is set", () => {
    expect(detectContext({ MCP_CLI_AI: "1" })).toBe("ai");
  });

  it("returns 'ai' when both CI and CLAUDECODE are set (agent-driven CI)", () => {
    // Without this precedence, an agent-driven CI run streams to the
    // workflow log instead of capturing to file — defeating the whole
    // context-preservation point. This was Copilot review #1x on PR #2037.
    expect(detectContext({ CI: "true", CLAUDECODE: "1" })).toBe("ai");
    expect(detectContext({ GITHUB_ACTIONS: "true", AGENT: "x" })).toBe("ai");
  });

  it("returns 'ci' when CI is set and no AI vars present", () => {
    expect(detectContext({ CI: "true" })).toBe("ci");
    expect(detectContext({ GITHUB_ACTIONS: "true" })).toBe("ci");
  });

  it("returns 'sh' for interactive shells", () => {
    expect(detectContext({ SHELL: "/bin/zsh" })).toBe("sh");
    expect(detectContext({ SHELL: "/usr/bin/bash" })).toBe("sh");
  });

  it("returns 'unknown' when no signal is present", () => {
    expect(detectContext({})).toBe("unknown");
  });
});
