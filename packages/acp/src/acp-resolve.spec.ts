import { describe, expect, it } from "bun:test";
import { type WhichFn, resolveAcpCommand } from "./acp-resolve";
import type { AcpAgent } from "./agents";

const copilot: AcpAgent = {
  name: "copilot",
  command: "copilot",
  args: ["--acp"],
  installHint: "Install with: gh extension install github/gh-copilot",
};

describe("resolveAcpCommand", () => {
  it("returns standalone binary when it exists", () => {
    const which: WhichFn = (bin) => (bin === "copilot" ? "/usr/local/bin/copilot" : null);
    expect(resolveAcpCommand(copilot, which)).toEqual(["copilot", "--acp"]);
  });

  it("falls back to gh extension when standalone is missing", () => {
    const which: WhichFn = (bin) => (bin === "gh" ? "/usr/bin/gh" : null);
    expect(resolveAcpCommand(copilot, which)).toEqual(["gh", "copilot", "--acp"]);
  });

  it("prefers standalone over gh when both exist", () => {
    const which: WhichFn = () => "/some/path";
    expect(resolveAcpCommand(copilot, which)).toEqual(["copilot", "--acp"]);
  });

  it("throws with install hint when neither is found", () => {
    const which: WhichFn = () => null;
    expect(() => resolveAcpCommand(copilot, which)).toThrow(/ACP agent `copilot` not found.*gh extension install/);
  });

  it("works with custom agent definitions", () => {
    const gemini: AcpAgent = {
      name: "gemini",
      command: "gemini",
      args: ["--acp"],
      installHint: "Install gemini-cli",
    };
    const which: WhichFn = (bin) => (bin === "gemini" ? "/usr/local/bin/gemini" : null);
    expect(resolveAcpCommand(gemini, which)).toEqual(["gemini", "--acp"]);
  });

  it("passes agent args through unchanged", () => {
    const custom: AcpAgent = {
      name: "test",
      command: "test-agent",
      args: ["--acp", "--verbose", "--json"],
      installHint: "n/a",
    };
    const which: WhichFn = (bin) => (bin === "gh" ? "/usr/bin/gh" : null);
    expect(resolveAcpCommand(custom, which)).toEqual(["gh", "test-agent", "--acp", "--verbose", "--json"]);
  });
});
