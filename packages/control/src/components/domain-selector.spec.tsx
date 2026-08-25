import { describe, expect, it } from "bun:test";
import type { Domain } from "@mcp-cli/core";
import { render } from "ink-testing-library";
import React from "react";
import { DomainSelector } from "./domain-selector";

const DOMAINS: Domain[] = [
  { id: 1, name: "mcp-cli", host: null, path: "/home/user/mcp-cli", createdAt: "2026-08-24T00:00:00.000Z" },
  { id: 2, name: "octavalve", host: null, path: "/home/user/octavalve", createdAt: "2026-08-24T00:00:00.000Z" },
];

describe("DomainSelector", () => {
  it("renders nothing when the domain list is empty", () => {
    const { lastFrame } = render(React.createElement(DomainSelector, { domains: [], selectedDomain: null }));
    expect(lastFrame()).toBe("");
  });

  it("renders domain names and the all option", () => {
    const { lastFrame } = render(
      React.createElement(DomainSelector, { domains: DOMAINS, selectedDomain: DOMAINS[0] ?? null }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("mcp-cli");
    expect(frame).toContain("octavalve");
    expect(frame).toContain("all");
  });

  it("highlights the selected domain", () => {
    const { lastFrame } = render(
      React.createElement(DomainSelector, { domains: DOMAINS, selectedDomain: DOMAINS[0] ?? null }),
    );
    const frame = lastFrame() ?? "";
    // The selected domain appears without brackets (rendered as inverse text) while
    // unselected ones appear in [brackets]
    expect(frame).toContain("[octavalve]");
    expect(frame).toContain("[all]");
  });

  it("matches the selection by id, not by name", () => {
    // Two domains can share a path prefix or be renamed between polls; the id is the
    // stable identity, so a stale name must not light up the wrong entry.
    const renamed: Domain = { ...(DOMAINS[0] as Domain), name: "was-mcp-cli" };
    const { lastFrame } = render(React.createElement(DomainSelector, { domains: DOMAINS, selectedDomain: renamed }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[octavalve]");
    expect(frame).not.toContain("[mcp-cli]");
  });

  it("highlights all when selectedDomain is null", () => {
    const { lastFrame } = render(React.createElement(DomainSelector, { domains: DOMAINS, selectedDomain: null }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[mcp-cli]");
    expect(frame).toContain("[octavalve]");
  });

  it("shows the S:switch hint", () => {
    const { lastFrame } = render(React.createElement(DomainSelector, { domains: DOMAINS, selectedDomain: null }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("S:switch");
  });
});
