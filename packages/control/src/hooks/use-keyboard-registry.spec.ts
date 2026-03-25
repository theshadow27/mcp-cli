import { describe, expect, it } from "bun:test";
import type { Key } from "ink";
import type { RegistryEntry } from "./registry-client";
import { type RegistryNav, buildInstallConfig, handleRegistryInput } from "./use-keyboard-registry";

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

function makeEntry(slug: string, overrides?: Partial<RegistryEntry["server"]>): RegistryEntry {
  return {
    server: {
      name: slug,
      title: slug,
      description: `${slug} description`,
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
      ...overrides,
    },
    _meta: {
      "com.anthropic.api/mcp-registry": {
        slug,
        displayName: slug,
        oneLiner: `${slug} one-liner`,
        toolNames: ["tool1"],
        isAuthless: true,
      },
    },
  };
}

function makeNav(overrides: Partial<RegistryNav> = {}): RegistryNav & { state: Record<string, unknown> } {
  const state: Record<string, unknown> = {
    selectedIndex: overrides.selectedIndex ?? 0,
    expandedEntry: overrides.expandedEntry ?? null,
    searchText: overrides.searchText ?? "",
    mode: overrides.mode ?? "browse",
    installTarget: overrides.installTarget ?? null,
    installTransport: overrides.installTransport ?? null,
    envInputs: overrides.envInputs ?? {},
    envCursor: overrides.envCursor ?? 0,
    envEditBuffer: overrides.envEditBuffer ?? "",
    installScope: overrides.installScope ?? "user",
    statusMessage: overrides.statusMessage ?? null,
  };

  // Use Object.defineProperties so property reads always reflect latest state
  const nav = {
    entries: overrides.entries ?? [makeEntry("foo"), makeEntry("bar"), makeEntry("baz")],
    setSelectedIndex: (fn: (i: number) => number) => {
      state.selectedIndex = fn(state.selectedIndex as number);
    },
    setExpandedEntry: (slug: string | null) => {
      state.expandedEntry = slug;
    },
    setSearchText: (fn: string | ((prev: string) => string)) => {
      state.searchText = typeof fn === "function" ? fn(state.searchText as string) : fn;
    },
    setMode: (mode: RegistryNav["mode"]) => {
      state.mode = mode;
    },
    onSearch: overrides.onSearch ?? (() => {}),
    onLoadPopular: overrides.onLoadPopular ?? (() => {}),
    setInstallTarget: (entry: RegistryEntry | null) => {
      state.installTarget = entry;
    },
    setInstallTransport: (t: RegistryNav["installTransport"]) => {
      state.installTransport = t;
    },
    setEnvInputs: (fn: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>)) => {
      state.envInputs = typeof fn === "function" ? fn(state.envInputs as Record<string, string>) : fn;
    },
    setEnvCursor: (fn: number | ((prev: number) => number)) => {
      state.envCursor = typeof fn === "function" ? fn(state.envCursor as number) : fn;
    },
    setEnvEditBuffer: (fn: string | ((prev: string) => string)) => {
      state.envEditBuffer = typeof fn === "function" ? fn(state.envEditBuffer as string) : fn;
    },
    setInstallScope: (scope: "user" | "project") => {
      state.installScope = scope;
    },
    setStatusMessage: (msg: string | null) => {
      state.statusMessage = msg;
    },
    onAddServer: overrides.onAddServer ?? (() => false),
    state,
  } as RegistryNav & { state: Record<string, unknown> };

  // Define getters that always read from state
  for (const key of [
    "selectedIndex",
    "expandedEntry",
    "searchText",
    "mode",
    "installTarget",
    "installTransport",
    "envInputs",
    "envCursor",
    "envEditBuffer",
    "installScope",
    "statusMessage",
  ] as const) {
    Object.defineProperty(nav, key, {
      get: () => state[key],
      enumerable: true,
    });
  }

  return nav;
}

describe("handleRegistryInput — browse mode", () => {
  it("navigates down with j", () => {
    const nav = makeNav();
    const consumed = handleRegistryInput("j", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.state.selectedIndex).toBe(1);
  });

  it("navigates up with k", () => {
    const nav = makeNav({ selectedIndex: 2 });
    handleRegistryInput("k", baseKey, nav);
    expect(nav.state.selectedIndex).toBe(1);
  });

  it("clamps at top", () => {
    const nav = makeNav({ selectedIndex: 0 });
    handleRegistryInput("k", baseKey, nav);
    expect(nav.state.selectedIndex).toBe(0);
  });

  it("clamps at bottom", () => {
    const nav = makeNav({ selectedIndex: 2 });
    handleRegistryInput("j", baseKey, nav);
    expect(nav.state.selectedIndex).toBe(2);
  });

  it("toggles detail on enter", () => {
    const nav = makeNav();
    handleRegistryInput("", { ...baseKey, return: true }, nav);
    expect(nav.state.expandedEntry).toBe("foo");
  });

  it("collapses detail on enter when already expanded", () => {
    const nav = makeNav({ expandedEntry: "foo" });
    handleRegistryInput("", { ...baseKey, return: true }, nav);
    expect(nav.state.expandedEntry).toBeNull();
  });

  it("opens search mode on /", () => {
    const nav = makeNav();
    handleRegistryInput("/", baseKey, nav);
    expect(nav.state.mode).toBe("search");
    expect(nav.state.searchText).toBe("");
  });

  it("opens search mode on f", () => {
    const nav = makeNav();
    handleRegistryInput("f", baseKey, nav);
    expect(nav.state.mode).toBe("search");
  });

  it("starts install flow on i", () => {
    const nav = makeNav();
    handleRegistryInput("i", baseKey, nav);
    // Should go to scope-pick (no env vars for HTTP remote)
    expect(nav.state.mode).toBe("scope-pick");
    expect(nav.state.installTarget).toBeTruthy();
  });

  it("shows error for entry with no installable transport", () => {
    const entries = [makeEntry("nope", { remotes: undefined, packages: undefined })];
    const nav = makeNav({ entries });
    handleRegistryInput("i", baseKey, nav);
    expect(nav.state.statusMessage).toContain("No installable transport");
    expect(nav.state.mode).toBe("browse");
  });
});

describe("handleRegistryInput — search mode", () => {
  it("accumulates typed characters", () => {
    const nav = makeNav({ mode: "search" });
    handleRegistryInput("h", baseKey, nav);
    handleRegistryInput("i", baseKey, nav);
    expect(nav.state.searchText).toBe("hi");
  });

  it("backspace removes last char", () => {
    const nav = makeNav({ mode: "search", searchText: "abc" });
    handleRegistryInput("", { ...baseKey, backspace: true }, nav);
    expect(nav.state.searchText).toBe("ab");
  });

  it("escape cancels search", () => {
    const nav = makeNav({ mode: "search", searchText: "abc" });
    handleRegistryInput("", { ...baseKey, escape: true }, nav);
    expect(nav.state.mode).toBe("browse");
  });

  it("enter triggers search callback", () => {
    let searchedQuery = "";
    const nav = makeNav({
      mode: "search",
      searchText: "test",
      onSearch: (q) => {
        searchedQuery = q;
      },
    });
    handleRegistryInput("", { ...baseKey, return: true }, nav);
    expect(searchedQuery).toBe("test");
    expect(nav.state.mode).toBe("browse");
  });

  it("enter with empty query triggers loadPopular", () => {
    let loaded = false;
    const nav = makeNav({
      mode: "search",
      searchText: "",
      onLoadPopular: () => {
        loaded = true;
      },
    });
    handleRegistryInput("", { ...baseKey, return: true }, nav);
    expect(loaded).toBe(true);
  });
});

describe("handleRegistryInput — scope pick mode", () => {
  it("toggles scope with j/k", () => {
    const nav = makeNav({ mode: "scope-pick", installScope: "user" });
    handleRegistryInput("j", baseKey, nav);
    expect(nav.state.installScope).toBe("project");
    handleRegistryInput("k", baseKey, nav);
    expect(nav.state.installScope).toBe("user");
  });

  it("enter advances to confirm", () => {
    const nav = makeNav({ mode: "scope-pick" });
    handleRegistryInput("", { ...baseKey, return: true }, nav);
    expect(nav.state.mode).toBe("confirm-install");
  });

  it("escape cancels", () => {
    const nav = makeNav({ mode: "scope-pick" });
    handleRegistryInput("", { ...baseKey, escape: true }, nav);
    expect(nav.state.mode).toBe("browse");
    expect(nav.state.installTarget).toBeNull();
  });
});

describe("handleRegistryInput — confirm install", () => {
  it("y triggers install", () => {
    let installed = false;
    const entry = makeEntry("test-server");
    const nav = makeNav({
      mode: "confirm-install",
      installTarget: entry,
      installTransport: { kind: "remote", transport: "http", url: "https://example.com/mcp" },
      onAddServer: () => {
        installed = true;
        return false;
      },
    });
    handleRegistryInput("y", baseKey, nav);
    expect(installed).toBe(true);
    expect(nav.state.mode).toBe("browse");
    expect(nav.state.statusMessage).toContain("Installed");
  });

  it("n cancels install", () => {
    const nav = makeNav({ mode: "confirm-install" });
    handleRegistryInput("n", baseKey, nav);
    expect(nav.state.mode).toBe("browse");
  });
});

describe("handleRegistryInput — env-input mode", () => {
  const stdioTransport = {
    kind: "package" as const,
    transport: "stdio" as const,
    command: "npx",
    commandArgs: ["-y", "my-pkg"],
    envVars: [
      { name: "API_KEY", isRequired: true, isSecret: true },
      { name: "SECRET", isRequired: true, isSecret: true },
    ],
  };

  it("accumulates typed characters in env buffer", () => {
    const nav = makeNav({
      mode: "env-input",
      installTransport: stdioTransport,
      envCursor: 0,
      envEditBuffer: "",
    });
    handleRegistryInput("a", baseKey, nav);
    handleRegistryInput("b", baseKey, nav);
    expect(nav.state.envEditBuffer).toBe("ab");
  });

  it("backspace removes last char from env buffer", () => {
    const nav = makeNav({
      mode: "env-input",
      installTransport: stdioTransport,
      envCursor: 0,
      envEditBuffer: "abc",
    });
    handleRegistryInput("", { ...baseKey, backspace: true }, nav);
    expect(nav.state.envEditBuffer).toBe("ab");
  });

  it("enter saves current var and advances cursor", () => {
    const nav = makeNav({
      mode: "env-input",
      installTransport: stdioTransport,
      envCursor: 0,
      envEditBuffer: "my-key-value",
      envInputs: { API_KEY: "", SECRET: "" },
    });
    handleRegistryInput("", { ...baseKey, return: true }, nav);
    expect((nav.state.envInputs as Record<string, string>).API_KEY).toBe("my-key-value");
    expect(nav.state.envCursor).toBe(1);
  });

  it("enter on last var advances to scope-pick", () => {
    const nav = makeNav({
      mode: "env-input",
      installTransport: stdioTransport,
      envCursor: 1, // last var
      envEditBuffer: "secret-val",
      envInputs: { API_KEY: "key-val", SECRET: "" },
    });
    handleRegistryInput("", { ...baseKey, return: true }, nav);
    expect(nav.state.mode).toBe("scope-pick");
  });

  it("tab advances like enter", () => {
    const nav = makeNav({
      mode: "env-input",
      installTransport: stdioTransport,
      envCursor: 0,
      envEditBuffer: "val",
      envInputs: { API_KEY: "", SECRET: "" },
    });
    handleRegistryInput("", { ...baseKey, tab: true }, nav);
    expect((nav.state.envInputs as Record<string, string>).API_KEY).toBe("val");
    expect(nav.state.envCursor).toBe(1);
  });

  it("escape cancels env input", () => {
    const nav = makeNav({ mode: "env-input", installTransport: stdioTransport });
    handleRegistryInput("", { ...baseKey, escape: true }, nav);
    expect(nav.state.mode).toBe("browse");
    expect(nav.state.installTarget).toBeNull();
  });
});

describe("handleRegistryInput — install with env vars (stdio)", () => {
  it("goes to env-input for entry with required env vars", () => {
    const entries = [
      makeEntry("env-server", {
        remotes: undefined,
        packages: [
          {
            registryType: "npm",
            identifier: "my-pkg",
            runtimeHint: "npx",
            transport: { type: "stdio" },
            environmentVariables: [{ name: "API_KEY", isRequired: true, isSecret: true }],
          },
        ],
      }),
    ];
    const nav = makeNav({ entries });
    handleRegistryInput("i", baseKey, nav);
    expect(nav.state.mode).toBe("env-input");
    expect(nav.state.installTransport).toBeTruthy();
  });

  it("shows error for templated entry", () => {
    const entries = [
      makeEntry("templated", {
        remotes: [{ type: "streamable-http", url: "https://{{user}}.example.com/mcp" }],
        packages: undefined,
      }),
    ];
    const nav = makeNav({ entries });
    handleRegistryInput("i", baseKey, nav);
    expect(nav.state.statusMessage).toContain("manual configuration");
    expect(nav.state.mode).toBe("browse");
  });

  it("enter on confirm triggers install with env vars", () => {
    let installedConfig: Record<string, unknown> | null = null;
    const entry = makeEntry("test-server");
    const nav = makeNav({
      mode: "confirm-install",
      installTarget: entry,
      installTransport: {
        kind: "package",
        transport: "stdio",
        command: "npx",
        commandArgs: ["-y", "my-pkg"],
        envVars: [{ name: "API_KEY", isRequired: true, isSecret: true }],
      },
      envInputs: { API_KEY: "secret123" },
      onAddServer: (_scope, _name, config) => {
        installedConfig = config as unknown as Record<string, unknown>;
        return false;
      },
    });
    handleRegistryInput("", { ...baseKey, return: true }, nav);
    expect(installedConfig).toBeTruthy();
    expect((installedConfig as unknown as Record<string, unknown>).command).toBe("npx");
    expect((installedConfig as unknown as Record<string, unknown>).env).toEqual({ API_KEY: "secret123" });
  });
});

describe("buildInstallConfig", () => {
  it("builds HTTP config", () => {
    const config = buildInstallConfig({ kind: "remote", transport: "http", url: "https://example.com/mcp" }, {});
    expect(config).toEqual({ type: "http", url: "https://example.com/mcp" });
  });

  it("builds SSE config", () => {
    const config = buildInstallConfig({ kind: "remote", transport: "sse", url: "https://example.com/sse" }, {});
    expect(config).toEqual({ type: "sse", url: "https://example.com/sse" });
  });

  it("builds stdio config with env overrides", () => {
    const config = buildInstallConfig(
      {
        kind: "package",
        transport: "stdio",
        command: "npx",
        commandArgs: ["-y", "my-pkg"],
        envVars: [{ name: "API_KEY", isRequired: true, isSecret: true }],
      },
      { API_KEY: "secret123" },
    );
    expect(config).toEqual({
      command: "npx",
      args: ["-y", "my-pkg"],
      env: { API_KEY: "secret123" },
    });
  });

  it("filters empty env var strings from config", () => {
    const config = buildInstallConfig(
      {
        kind: "package",
        transport: "stdio",
        command: "npx",
        commandArgs: ["-y", "my-pkg"],
        envVars: [
          { name: "API_KEY", isRequired: true, isSecret: true },
          { name: "EMPTY_VAR", isRequired: true, isSecret: false },
        ],
      },
      { API_KEY: "secret123", EMPTY_VAR: "" },
    );
    expect(config).toEqual({
      command: "npx",
      args: ["-y", "my-pkg"],
      env: { API_KEY: "secret123" },
    });
  });

  it("omits env entirely when all values are empty", () => {
    const config = buildInstallConfig(
      {
        kind: "package",
        transport: "stdio",
        command: "npx",
        commandArgs: ["-y", "my-pkg"],
        envVars: [{ name: "API_KEY", isRequired: true, isSecret: true }],
      },
      { API_KEY: "" },
    );
    expect(config).toEqual({
      command: "npx",
      args: ["-y", "my-pkg"],
    });
  });
});

describe("doInstall — overwrite and error handling", () => {
  it("shows replaced message when overwriting existing server", () => {
    const entry = makeEntry("test-server");
    const nav = makeNav({
      mode: "confirm-install",
      installTarget: entry,
      installTransport: { kind: "remote", transport: "http", url: "https://example.com/mcp" },
      onAddServer: () => true, // signals replacement
    });
    handleRegistryInput("y", baseKey, nav);
    expect(nav.state.statusMessage).toContain("Replaced existing");
  });

  it("shows error message when addServerToConfig throws", () => {
    const entry = makeEntry("test-server");
    const nav = makeNav({
      mode: "confirm-install",
      installTarget: entry,
      installTransport: { kind: "remote", transport: "http", url: "https://example.com/mcp" },
      onAddServer: () => {
        throw new Error("Permission denied");
      },
    });
    handleRegistryInput("y", baseKey, nav);
    expect(nav.state.statusMessage).toContain("Install failed");
    expect(nav.state.statusMessage).toContain("Permission denied");
    expect(nav.state.mode).toBe("browse");
    expect(nav.state.installTarget).toBeNull();
  });
});
