import { describe, expect, it } from "bun:test";
import type { ScopeMatch } from "@mcp-cli/core";
import { render } from "ink-testing-library";
import React from "react";
import { ScopeSelector } from "./scope-selector";

const SCOPES: ScopeMatch[] = [
  { name: "mcp-cli", root: "/home/user/mcp-cli" },
  { name: "octavalve", root: "/home/user/octavalve" },
];

describe("ScopeSelector", () => {
  it("renders nothing when scopes list is empty", () => {
    const { lastFrame } = render(React.createElement(ScopeSelector, { scopes: [], selectedScope: null }));
    expect(lastFrame()).toBe("");
  });

  it("renders scope names and all option", () => {
    const { lastFrame } = render(React.createElement(ScopeSelector, { scopes: SCOPES, selectedScope: SCOPES[0] }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("mcp-cli");
    expect(frame).toContain("octavalve");
    expect(frame).toContain("all");
  });

  it("highlights selected scope", () => {
    const { lastFrame } = render(React.createElement(ScopeSelector, { scopes: SCOPES, selectedScope: SCOPES[0] }));
    const frame = lastFrame() ?? "";
    // The selected scope should appear without brackets (rendered as inverse text)
    // while unselected ones appear in [brackets]
    expect(frame).toContain("[octavalve]");
    expect(frame).toContain("[all]");
  });

  it("highlights all when selectedScope is null", () => {
    const { lastFrame } = render(React.createElement(ScopeSelector, { scopes: SCOPES, selectedScope: null }));
    const frame = lastFrame() ?? "";
    // Both scopes should be in brackets (unselected), "all" should be highlighted
    expect(frame).toContain("[mcp-cli]");
    expect(frame).toContain("[octavalve]");
  });

  it("shows S:switch hint", () => {
    const { lastFrame } = render(React.createElement(ScopeSelector, { scopes: SCOPES, selectedScope: null }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("S:switch");
  });
});
