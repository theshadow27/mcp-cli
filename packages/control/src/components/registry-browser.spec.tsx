import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import type { RegistryEntry } from "../hooks/registry-client";
import { RegistryBrowser } from "./registry-browser";

function makeEntry(slug: string): RegistryEntry {
  return {
    server: {
      name: slug,
      title: slug,
      description: `${slug} description`,
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
    },
    _meta: {
      "com.anthropic.api/mcp-registry": {
        slug,
        displayName: `${slug} Display`,
        oneLiner: `${slug} one-liner`,
        toolNames: ["tool1", "tool2"],
        isAuthless: true,
      },
    },
  };
}

const defaultProps = {
  entries: [] as RegistryEntry[],
  selectedIndex: 0,
  expandedEntry: null,
  loading: false,
  error: null,
  searchText: "",
  mode: "browse" as const,
  statusMessage: null,
  installTarget: null,
  installTransport: null,
  envInputs: {},
  envCursor: 0,
  envEditBuffer: "",
  installScope: "user" as const,
};

describe("RegistryBrowser", () => {
  test("shows empty state when no results", () => {
    const { lastFrame } = render(<RegistryBrowser {...defaultProps} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("No results");
  });

  test("shows loading state", () => {
    const { lastFrame } = render(<RegistryBrowser {...defaultProps} loading />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Loading");
  });

  test("shows error message", () => {
    const { lastFrame } = render(<RegistryBrowser {...defaultProps} error="Network error" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Network error");
  });

  test("renders entry list", () => {
    const entries = [makeEntry("foo"), makeEntry("bar")];
    const { lastFrame } = render(<RegistryBrowser {...defaultProps} entries={entries} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("foo");
    expect(frame).toContain("bar");
    expect(frame).toContain("2 server(s)");
  });

  test("shows selected entry with indicator", () => {
    const entries = [makeEntry("foo"), makeEntry("bar")];
    const { lastFrame } = render(<RegistryBrowser {...defaultProps} entries={entries} selectedIndex={0} />);
    const frame = lastFrame() ?? "";
    // First entry should have the selection indicator
    expect(frame).toContain("❯");
    expect(frame).toContain("foo");
  });

  test("shows expanded entry detail", () => {
    const entries = [makeEntry("foo")];
    const { lastFrame } = render(<RegistryBrowser {...defaultProps} entries={entries} expandedEntry="foo" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("foo description");
    expect(frame).toContain("streamable-http");
    expect(frame).toContain("tool1");
  });

  test("shows search input in search mode", () => {
    const { lastFrame } = render(<RegistryBrowser {...defaultProps} mode="search" searchText="test" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("search:");
    expect(frame).toContain("test");
  });

  test("shows scope picker in scope-pick mode", () => {
    const { lastFrame } = render(<RegistryBrowser {...defaultProps} mode="scope-pick" installScope="user" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Install Scope");
    expect(frame).toContain("user");
    expect(frame).toContain("project");
  });

  test("shows confirm in confirm-install mode", () => {
    const entry = makeEntry("test-server");
    const transport = { kind: "remote" as const, transport: "http" as const, url: "https://example.com/mcp" };
    const { lastFrame } = render(
      <RegistryBrowser
        {...defaultProps}
        mode="confirm-install"
        installTarget={entry}
        installTransport={transport}
        installScope="user"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Confirm Install");
    expect(frame).toContain("test-server");
    expect(frame).toContain("http");
  });

  test("shows status message", () => {
    const { lastFrame } = render(<RegistryBrowser {...defaultProps} statusMessage="Installed successfully" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Installed successfully");
  });

  test("shows tool count per entry", () => {
    const entries = [makeEntry("foo")];
    const { lastFrame } = render(<RegistryBrowser {...defaultProps} entries={entries} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("2 tools");
  });

  test("shows env input form in env-input mode", () => {
    const transport = {
      kind: "package" as const,
      transport: "stdio" as const,
      command: "npx",
      commandArgs: ["-y", "my-pkg"],
      envVars: [
        { name: "API_KEY", isRequired: true, isSecret: true, description: "Your API key" },
        { name: "SECRET", isRequired: true, isSecret: true },
      ],
    };
    const { lastFrame } = render(
      <RegistryBrowser
        {...defaultProps}
        mode="env-input"
        installTransport={transport}
        envInputs={{ API_KEY: "", SECRET: "" }}
        envCursor={0}
        envEditBuffer="my-secret"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Environment Variables");
    expect(frame).toContain("API_KEY");
    expect(frame).toContain("SECRET");
    expect(frame).toContain("my-secret");
    expect(frame).toContain("Your API key");
  });

  test("shows search text in browse mode when present", () => {
    const { lastFrame } = render(<RegistryBrowser {...defaultProps} searchText="my query" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("my query");
  });

  test("shows documentation link in expanded detail", () => {
    const entry: RegistryEntry = {
      server: {
        name: "doc-server",
        title: "doc-server",
        description: "has docs",
        version: "1.0.0",
        remotes: [{ type: "streamable-http", url: "https://example.com" }],
      },
      _meta: {
        "com.anthropic.api/mcp-registry": {
          slug: "doc-server",
          displayName: "Doc Server",
          oneLiner: "A server with docs",
          toolNames: ["t1"],
          isAuthless: true,
          documentation: "https://docs.example.com",
        },
      },
    };
    const { lastFrame } = render(<RegistryBrowser {...defaultProps} entries={[entry]} expandedEntry="doc-server" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("https://docs.example.com");
    expect(frame).toContain("Docs:");
  });
});
