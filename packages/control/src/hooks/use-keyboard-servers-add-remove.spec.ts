import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import { initialAddServerState } from "../components/server-add-form";
import type { ServersNav } from "./use-keyboard";
import { buildConfig, handleServersInput } from "./use-keyboard-servers";

const baseKey: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

function makeNav(overrides: Partial<ServersNav> = {}): ServersNav {
  return {
    servers: [
      { name: "s1", state: "connected", transport: "stdio", toolCount: 0, source: "test" },
      { name: "s2", state: "connected", transport: "http", toolCount: 0, source: "test" },
    ] as ServersNav["servers"],
    selectedIndex: 0,
    setSelectedIndex: mock(() => {}),
    expandedServer: null,
    setExpandedServer: mock(() => {}),
    refresh: mock(() => {}),
    authStatus: null,
    setAuthStatus: mock(() => {}),
    addServerMode: false,
    setAddServerMode: mock(() => {}),
    addServerState: initialAddServerState(),
    setAddServerState: mock(() => {}),
    confirmRemove: false,
    setConfirmRemove: mock(() => {}),
    configInfo: {
      s1: { source: "/path/servers.json", scope: "user" },
      s2: { source: "/path/servers.json", scope: "project" },
    },
    ...overrides,
  };
}

describe("buildConfig", () => {
  test("builds http config", () => {
    const state = {
      ...initialAddServerState(),
      transport: "http" as const,
      name: "test",
      url: "https://example.com/mcp",
    };
    const config = buildConfig(state);
    expect(config).toEqual({ type: "http", url: "https://example.com/mcp" });
  });

  test("builds sse config", () => {
    const state = {
      ...initialAddServerState(),
      transport: "sse" as const,
      name: "test",
      url: "https://sse.example.com",
    };
    const config = buildConfig(state);
    expect(config).toEqual({ type: "sse", url: "https://sse.example.com" });
  });

  test("builds stdio config with command and args", () => {
    const state = {
      ...initialAddServerState(),
      transport: "stdio" as const,
      name: "test",
      url: "npx -y some-pkg",
    };
    const config = buildConfig(state);
    expect(config).toEqual({ command: "npx", args: ["-y", "some-pkg"] });
  });

  test("builds stdio config with env vars", () => {
    const state = {
      ...initialAddServerState(),
      transport: "stdio" as const,
      name: "test",
      url: "node server.js",
      env: ["PORT=3000", "DEBUG=true"],
    };
    const config = buildConfig(state);
    expect(config).toEqual({
      command: "node",
      args: ["server.js"],
      env: { PORT: "3000", DEBUG: "true" },
    });
  });

  test("http config ignores env vars (not supported by HttpServerConfig)", () => {
    const state = {
      ...initialAddServerState(),
      transport: "http" as const,
      name: "test",
      url: "https://example.com",
      env: ["API_KEY=abc123"],
    };
    const config = buildConfig(state);
    expect(config).toEqual({ type: "http", url: "https://example.com" });
    expect("env" in config).toBe(false);
  });

  test("sse config ignores env vars (not supported by SseServerConfig)", () => {
    const state = {
      ...initialAddServerState(),
      transport: "sse" as const,
      name: "test",
      url: "https://example.com",
      env: ["API_KEY=abc123"],
    };
    const config = buildConfig(state);
    expect(config).toEqual({ type: "sse", url: "https://example.com" });
    expect("env" in config).toBe(false);
  });

  test("ignores invalid env entries (no = sign) for stdio", () => {
    const state = {
      ...initialAddServerState(),
      transport: "stdio" as const,
      url: "node server.js",
      env: ["INVALID", "GOOD=val"],
    };
    const config = buildConfig(state);
    expect((config as { env?: Record<string, string> }).env).toEqual({ GOOD: "val" });
  });
});

describe("add server mode", () => {
  test("n key enters add server mode", () => {
    const nav = makeNav();
    const consumed = handleServersInput("n", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setAddServerMode).toHaveBeenCalledWith(true);
    expect(nav.setAddServerState).toHaveBeenCalled();
  });

  test("+ key enters add server mode", () => {
    const nav = makeNav();
    const consumed = handleServersInput("+", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setAddServerMode).toHaveBeenCalledWith(true);
  });

  test("escape cancels add server mode", () => {
    const nav = makeNav({ addServerMode: true });
    const consumed = handleServersInput("", { ...baseKey, escape: true }, nav);
    expect(consumed).toBe(true);
    expect(nav.setAddServerMode).toHaveBeenCalledWith(false);
  });

  test("transport step: j cycles transport down", () => {
    const state = initialAddServerState();
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("j", baseKey, nav);
    expect(nav.setAddServerState).toHaveBeenCalled();
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { transport: string }).transport).toBe("sse");
  });

  test("transport step: downArrow cycles transport down", () => {
    const state = initialAddServerState();
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, downArrow: true }, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { transport: string }).transport).toBe("sse");
  });

  test("transport step: k cycles transport up (clamps at 0)", () => {
    const state = initialAddServerState();
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("k", baseKey, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { transport: string }).transport).toBe("http");
  });

  test("transport step: upArrow cycles transport up", () => {
    const state = { ...initialAddServerState(), transport: "sse" as const };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, upArrow: true }, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { transport: string }).transport).toBe("http");
  });

  test("transport step: clamps at last option", () => {
    const state = { ...initialAddServerState(), transport: "stdio" as const };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("j", baseKey, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { transport: string }).transport).toBe("stdio");
  });

  test("transport step: enter advances to name step", () => {
    const state = initialAddServerState();
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, return: true }, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { step: string }).step).toBe("name");
  });

  test("transport step: swallows other input", () => {
    const state = initialAddServerState();
    const nav = makeNav({ addServerMode: true, addServerState: state });
    const consumed = handleServersInput("z", baseKey, nav);
    expect(consumed).toBe(true);
  });

  test("name step: typing appends to name", () => {
    const state = { ...initialAddServerState(), step: "name" as const };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("t", baseKey, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { name: string }).name).toBe("t");
  });

  test("name step: backspace removes last char", () => {
    const state = { ...initialAddServerState(), step: "name" as const, name: "test" };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, backspace: true }, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { name: string }).name).toBe("tes");
  });

  test("name step: delete removes last char", () => {
    const state = { ...initialAddServerState(), step: "name" as const, name: "ab" };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, delete: true }, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { name: string }).name).toBe("a");
  });

  test("name step: enter with empty name does not advance", () => {
    const state = { ...initialAddServerState(), step: "name" as const, name: "" };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, return: true }, nav);
    expect(nav.setAddServerState).not.toHaveBeenCalled();
  });

  test("name step: enter with name advances to url step", () => {
    const state = { ...initialAddServerState(), step: "name" as const, name: "my-server" };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, return: true }, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { step: string }).step).toBe("url");
  });

  test("name step: ctrl+key is ignored", () => {
    const state = { ...initialAddServerState(), step: "name" as const };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    const consumed = handleServersInput("c", { ...baseKey, ctrl: true }, nav);
    expect(consumed).toBe(true);
    expect(nav.setAddServerState).not.toHaveBeenCalled();
  });

  test("url step: typing appends to url", () => {
    const state = { ...initialAddServerState(), step: "url" as const, url: "http" };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("s", baseKey, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { url: string }).url).toBe("https");
  });

  test("url step: backspace removes last char", () => {
    const state = { ...initialAddServerState(), step: "url" as const, url: "https" };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, backspace: true }, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { url: string }).url).toBe("http");
  });

  test("url step: enter with empty url does not advance", () => {
    const state = { ...initialAddServerState(), step: "url" as const, url: "" };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, return: true }, nav);
    expect(nav.setAddServerState).not.toHaveBeenCalled();
  });

  test("url step: enter with url advances to scope for http (skips env)", () => {
    const state = { ...initialAddServerState(), step: "url" as const, url: "https://example.com" };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, return: true }, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { step: string }).step).toBe("scope");
  });

  test("url step: enter with url advances to scope for sse (skips env)", () => {
    const state = {
      ...initialAddServerState(),
      step: "url" as const,
      url: "https://example.com",
      transport: "sse" as const,
    };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, return: true }, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { step: string }).step).toBe("scope");
  });

  test("url step: enter with url advances to env for stdio", () => {
    const state = {
      ...initialAddServerState(),
      step: "url" as const,
      url: "node server.js",
      transport: "stdio" as const,
    };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, return: true }, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { step: string }).step).toBe("env");
  });

  test("env step: tab skips to scope", () => {
    const state = { ...initialAddServerState(), step: "env" as const };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, tab: true }, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { step: string }).step).toBe("scope");
  });

  test("env step: typing appends to envInput", () => {
    const state = { ...initialAddServerState(), step: "env" as const, envInput: "KEY" };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("=", baseKey, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { envInput: string }).envInput).toBe("KEY=");
  });

  test("env step: backspace removes from envInput", () => {
    const state = { ...initialAddServerState(), step: "env" as const, envInput: "KEY=" };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, backspace: true }, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { envInput: string }).envInput).toBe("KEY");
  });

  test("env step: enter with valid KEY=VALUE adds env var", () => {
    const state = { ...initialAddServerState(), step: "env" as const, envInput: "KEY=val" };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, return: true }, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    const result = call[0] as { env: string[]; envInput: string };
    expect(result.env).toEqual(["KEY=val"]);
    expect(result.envInput).toBe("");
  });

  test("env step: enter with empty input skips to scope", () => {
    const state = { ...initialAddServerState(), step: "env" as const, envInput: "" };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, return: true }, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { step: string }).step).toBe("scope");
  });

  test("env step: enter with no = sign does not add", () => {
    const state = { ...initialAddServerState(), step: "env" as const, envInput: "NOEQUALS" };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, return: true }, nav);
    // Should not add to env or advance
    expect(nav.setAddServerState).not.toHaveBeenCalled();
  });

  test("scope step: j/k toggles scope", () => {
    const state = { ...initialAddServerState(), step: "scope" as const, scope: "user" as const };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("j", baseKey, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { scope: string }).scope).toBe("project");
  });

  test("scope step: downArrow toggles scope", () => {
    const state = { ...initialAddServerState(), step: "scope" as const, scope: "project" as const };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, downArrow: true }, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { scope: string }).scope).toBe("user");
  });

  test("scope step: enter advances to confirm", () => {
    const state = { ...initialAddServerState(), step: "scope" as const };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    handleServersInput("", { ...baseKey, return: true }, nav);
    const call = (nav.setAddServerState as ReturnType<typeof mock>).mock.calls[0];
    expect((call[0] as { step: string }).step).toBe("confirm");
  });

  test("scope step: swallows other input", () => {
    const state = { ...initialAddServerState(), step: "scope" as const };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    const consumed = handleServersInput("z", baseKey, nav);
    expect(consumed).toBe(true);
  });

  test("confirm step: swallows non-enter input", () => {
    const state = { ...initialAddServerState(), step: "confirm" as const };
    const nav = makeNav({ addServerMode: true, addServerState: state });
    const consumed = handleServersInput("z", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setAddServerMode).not.toHaveBeenCalled();
  });

  test("confirm step: enter calls onAddServer with correct args and exits", () => {
    const onAddServer = mock(() => {});
    const state = {
      ...initialAddServerState(),
      step: "confirm" as const,
      transport: "http" as const,
      name: "my-server",
      url: "https://example.com/mcp",
      scope: "project" as const,
    };
    const nav = makeNav({ addServerMode: true, addServerState: state, onAddServer });
    const consumed = handleServersInput("", { ...baseKey, return: true }, nav);
    expect(consumed).toBe(true);
    expect(onAddServer).toHaveBeenCalledWith("project", "my-server", {
      type: "http",
      url: "https://example.com/mcp",
    });
    expect(nav.setAddServerMode).toHaveBeenCalledWith(false);
  });

  test("confirm step: enter with stdio calls onAddServer with command config", () => {
    const onAddServer = mock(() => {});
    const state = {
      ...initialAddServerState(),
      step: "confirm" as const,
      transport: "stdio" as const,
      name: "local-server",
      url: "npx -y some-pkg",
      env: ["API_KEY=secret"],
      scope: "user" as const,
    };
    const nav = makeNav({ addServerMode: true, addServerState: state, onAddServer });
    handleServersInput("", { ...baseKey, return: true }, nav);
    expect(onAddServer).toHaveBeenCalledWith("user", "local-server", {
      command: "npx",
      args: ["-y", "some-pkg"],
      env: { API_KEY: "secret" },
    });
  });
});

describe("remove server mode", () => {
  test("d key enters confirm remove mode", () => {
    const nav = makeNav();
    const consumed = handleServersInput("d", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setConfirmRemove).toHaveBeenCalledWith(true);
  });

  test("x key enters confirm remove mode", () => {
    const nav = makeNav();
    const consumed = handleServersInput("x", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setConfirmRemove).toHaveBeenCalledWith(true);
  });

  test("n cancels confirm remove", () => {
    const nav = makeNav({ confirmRemove: true });
    const consumed = handleServersInput("n", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setConfirmRemove).toHaveBeenCalledWith(false);
  });

  test("escape cancels confirm remove", () => {
    const nav = makeNav({ confirmRemove: true });
    const consumed = handleServersInput("", { ...baseKey, escape: true }, nav);
    expect(consumed).toBe(true);
    expect(nav.setConfirmRemove).toHaveBeenCalledWith(false);
  });

  test("confirm remove swallows unrecognized input", () => {
    const nav = makeNav({ confirmRemove: true });
    const consumed = handleServersInput("z", baseKey, nav);
    expect(consumed).toBe(true);
  });

  test("d with no servers does nothing", () => {
    const nav = makeNav({ servers: [] as ServersNav["servers"] });
    const consumed = handleServersInput("d", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setConfirmRemove).not.toHaveBeenCalled();
  });

  test("y confirm calls onRemoveServer with correct scope", () => {
    const onRemoveServer = mock(() => {});
    const nav = makeNav({ confirmRemove: true, selectedIndex: 1, onRemoveServer });
    const consumed = handleServersInput("y", baseKey, nav);
    expect(consumed).toBe(true);
    // s2 is project-scoped in makeNav configInfo
    expect(onRemoveServer).toHaveBeenCalledWith("project", "s2");
    expect(nav.setConfirmRemove).toHaveBeenCalledWith(false);
  });

  test("y confirm with user-scoped server calls onRemoveServer with user scope", () => {
    const onRemoveServer = mock(() => {});
    const nav = makeNav({ confirmRemove: true, selectedIndex: 0, onRemoveServer });
    handleServersInput("y", baseKey, nav);
    // s1 is user-scoped in makeNav configInfo
    expect(onRemoveServer).toHaveBeenCalledWith("user", "s1");
  });

  test("y confirm aborts when configInfo is empty (not loaded yet)", () => {
    const onRemoveServer = mock(() => {});
    const nav = makeNav({ confirmRemove: true, configInfo: {}, onRemoveServer });
    const consumed = handleServersInput("y", baseKey, nav);
    expect(consumed).toBe(true);
    expect(onRemoveServer).not.toHaveBeenCalled();
    expect(nav.setConfirmRemove).toHaveBeenCalledWith(false);
  });
});
