import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { type AddServerState, ServerAddForm, initialAddServerState } from "./server-add-form";

function renderForm(overrides: Partial<AddServerState> = {}) {
  const state: AddServerState = { ...initialAddServerState(), ...overrides };
  const { lastFrame } = render(<ServerAddForm state={state} />);
  return lastFrame() ?? "";
}

describe("ServerAddForm", () => {
  test("renders transport picker on transport step", () => {
    const frame = renderForm({ step: "transport" });
    expect(frame).toContain("Add Server");
    expect(frame).toContain("Transport:");
    expect(frame).toContain("http");
    expect(frame).toContain("sse");
    expect(frame).toContain("stdio");
    expect(frame).toContain("j/k select");
  });

  test("highlights selected transport", () => {
    const frame = renderForm({ step: "transport", transport: "sse" });
    expect(frame).toContain("sse");
  });

  test("renders name input on name step", () => {
    const frame = renderForm({ step: "name", transport: "http" });
    expect(frame).toContain("Name:");
    expect(frame).toContain("type name");
  });

  test("shows entered name text", () => {
    const frame = renderForm({ step: "name", name: "my-server" });
    expect(frame).toContain("my-server");
  });

  test("renders URL input on url step for http", () => {
    const frame = renderForm({ step: "url", transport: "http", name: "test" });
    expect(frame).toContain("URL:");
    expect(frame).toContain("type url");
  });

  test("renders Command input on url step for stdio", () => {
    const frame = renderForm({ step: "url", transport: "stdio", name: "test" });
    expect(frame).toContain("Command:");
    expect(frame).toContain("type command");
  });

  test("renders env step with existing env vars", () => {
    const frame = renderForm({
      step: "env",
      transport: "http",
      name: "test",
      url: "https://example.com",
      env: ["KEY=val"],
    });
    expect(frame).toContain("Env vars:");
    expect(frame).toContain("KEY=val");
    expect(frame).toContain("Add env (KEY=VALUE):");
  });

  test("renders env step with no existing vars", () => {
    const frame = renderForm({ step: "env", transport: "http", name: "test", url: "https://example.com" });
    expect(frame).toContain("Add env (KEY=VALUE):");
    expect(frame).toContain("tab skip");
  });

  test("renders scope picker on scope step", () => {
    const frame = renderForm({ step: "scope", transport: "http", name: "test" });
    expect(frame).toContain("Scope:");
    expect(frame).toContain("user");
    expect(frame).toContain("project");
  });

  test("renders confirm step with all details", () => {
    const frame = renderForm({
      step: "confirm",
      transport: "http",
      name: "my-server",
      url: "https://example.com",
      env: ["API_KEY=abc"],
      scope: "user",
    });
    expect(frame).toContain("http");
    expect(frame).toContain("my-server");
    expect(frame).toContain("https://example.com");
    expect(frame).toContain("API_KEY=abc");
    expect(frame).toContain("user");
    expect(frame).toContain("enter save");
  });

  test("confirm step hides env when empty", () => {
    const frame = renderForm({
      step: "confirm",
      transport: "sse",
      name: "test",
      url: "https://sse.example.com",
      env: [],
      scope: "project",
    });
    expect(frame).not.toContain("Env:");
    expect(frame).toContain("project");
  });
});
