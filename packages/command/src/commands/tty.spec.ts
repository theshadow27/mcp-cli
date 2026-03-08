import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliConfig } from "@mcp-cli/core";
import { ExitError } from "../test-helpers";
import type { TerminalAdapter } from "../tty/adapter";
import { TERMINAL_NAMES, getAdapter } from "../tty/adapter";
import { GhosttyAdapter } from "../tty/adapters/ghostty";
import { ItermAdapter } from "../tty/adapters/iterm";
import { KittyAdapter } from "../tty/adapters/kitty";
import { TerminalAppAdapter } from "../tty/adapters/terminal-app";
import { TmuxAdapter } from "../tty/adapters/tmux";
import { WeztermAdapter } from "../tty/adapters/wezterm";
import { detectTerminal } from "../tty/detect";
import { spawnHeadless } from "../tty/headless";
import type { SpawnFn } from "../tty/spawn";
import type { TtyDeps } from "./tty";
import { cmdTty, parseTtyOpenArgs, ttyOpen } from "./tty";

// -- Helpers --

function makeDeps(overrides?: Partial<TtyDeps>): TtyDeps {
  return {
    readCliConfig: () => ({}) as CliConfig,
    detectTerminal: () => "ghostty",
    getAdapter: mock(
      () =>
        ({
          name: "MockTerminal",
          open: mock(async () => {}),
        }) satisfies TerminalAdapter,
    ),
    spawnHeadless: mock(async () => ({ pid: 12345, logFile: "/tmp/test.log" })),
    printError: mock(() => {}),
    exit: mock((code: number) => {
      throw new ExitError(code);
    }) as TtyDeps["exit"],
    ...overrides,
  };
}

/** Create a mock SpawnFn that records calls */
function mockSpawn(): SpawnFn & { calls: Array<{ args: string[]; label: string }> } {
  const calls: Array<{ args: string[]; label: string }> = [];
  const fn = async (args: string[], label: string) => {
    calls.push({ args, label });
  };
  (fn as ReturnType<typeof mockSpawn>).calls = calls;
  return fn as ReturnType<typeof mockSpawn>;
}

// -- parseTtyOpenArgs --

describe("parseTtyOpenArgs", () => {
  test("parses simple command", () => {
    const result = parseTtyOpenArgs(["echo", "hello"]);
    expect(result).toEqual({ command: "echo hello", mode: "tab", headless: false, error: undefined });
  });

  test("parses --window flag", () => {
    const result = parseTtyOpenArgs(["--window", "bun", "test"]);
    expect(result).toEqual({ command: "bun test", mode: "window", headless: false, error: undefined });
  });

  test("parses --headless flag", () => {
    const result = parseTtyOpenArgs(["--headless", "sleep", "10"]);
    expect(result).toEqual({ command: "sleep 10", mode: "tab", headless: true, error: undefined });
  });

  test("errors on --headless + --window", () => {
    const result = parseTtyOpenArgs(["--headless", "--window", "cmd"]);
    expect(result.error).toBe("--headless and --window are mutually exclusive");
  });

  test("returns undefined command when no args", () => {
    const result = parseTtyOpenArgs([]);
    expect(result.command).toBeUndefined();
  });

  test("quoted command as single arg", () => {
    const result = parseTtyOpenArgs(["bun test --watch"]);
    expect(result.command).toBe("bun test --watch");
  });
});

// -- detectTerminal --

describe("detectTerminal", () => {
  test("detects tmux from $TMUX", () => {
    expect(detectTerminal({ TMUX: "/tmp/tmux-501/default,12345,0" })).toBe("tmux");
  });

  test("detects ghostty from $TERM_PROGRAM", () => {
    expect(detectTerminal({ TERM_PROGRAM: "ghostty" })).toBe("ghostty");
  });

  test("detects iTerm from $TERM_PROGRAM", () => {
    expect(detectTerminal({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm");
  });

  test("detects Terminal.app", () => {
    expect(detectTerminal({ TERM_PROGRAM: "Apple_Terminal" })).toBe("terminal");
  });

  test("detects kitty", () => {
    expect(detectTerminal({ TERM_PROGRAM: "kitty" })).toBe("kitty");
  });

  test("detects WezTerm", () => {
    expect(detectTerminal({ TERM_PROGRAM: "WezTerm" })).toBe("wezterm");
  });

  test("returns undefined for unknown terminal", () => {
    expect(detectTerminal({ TERM_PROGRAM: "unknown-term" })).toBeUndefined();
  });

  test("returns undefined for empty env", () => {
    expect(detectTerminal({})).toBeUndefined();
  });

  test("$TMUX takes precedence over $TERM_PROGRAM", () => {
    expect(detectTerminal({ TMUX: "/tmp/tmux", TERM_PROGRAM: "ghostty" })).toBe("tmux");
  });
});

// -- getAdapter --

describe("getAdapter", () => {
  test("returns adapter for each known terminal", () => {
    for (const name of TERMINAL_NAMES) {
      const adapter = getAdapter(name);
      expect(adapter.name).toBeTruthy();
      expect(typeof adapter.open).toBe("function");
    }
  });

  test("throws for unknown terminal", () => {
    expect(() => getAdapter("nonexistent")).toThrow(/Unknown terminal/);
  });
});

// -- Terminal adapters --

describe("GhosttyAdapter", () => {
  test("opens tab with osascript", async () => {
    const spawn = mockSpawn();
    const adapter = new GhosttyAdapter(spawn);
    await adapter.open("echo hello", "tab");
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0].args[0]).toBe("osascript");
    expect(spawn.calls[0].args[2]).toContain("New Tab");
    expect(spawn.calls[0].args[2]).toContain("echo hello");
    expect(spawn.calls[0].label).toBe("Ghostty");
  });

  test("opens window with osascript", async () => {
    const spawn = mockSpawn();
    const adapter = new GhosttyAdapter(spawn);
    await adapter.open("bun test", "window");
    expect(spawn.calls[0].args[2]).toContain("New Window");
  });

  test("escapes quotes in command", async () => {
    const spawn = mockSpawn();
    const adapter = new GhosttyAdapter(spawn);
    await adapter.open('echo "hello"', "tab");
    expect(spawn.calls[0].args[2]).toContain('\\"hello\\"');
  });
});

describe("ItermAdapter", () => {
  test("opens tab via iTerm2 scripting", async () => {
    const spawn = mockSpawn();
    const adapter = new ItermAdapter(spawn);
    await adapter.open("ls -la", "tab");
    expect(spawn.calls[0].args[2]).toContain("create tab with default profile");
    expect(spawn.calls[0].args[2]).toContain("ls -la");
  });

  test("opens window via iTerm2 scripting", async () => {
    const spawn = mockSpawn();
    const adapter = new ItermAdapter(spawn);
    await adapter.open("ls", "window");
    expect(spawn.calls[0].args[2]).toContain("create window with default profile");
  });
});

describe("TerminalAppAdapter", () => {
  test("opens tab via System Events", async () => {
    const spawn = mockSpawn();
    const adapter = new TerminalAppAdapter(spawn);
    await adapter.open("pwd", "tab");
    expect(spawn.calls[0].args[2]).toContain("New Tab");
    expect(spawn.calls[0].args[2]).toContain("pwd");
  });

  test("opens window via do script", async () => {
    const spawn = mockSpawn();
    const adapter = new TerminalAppAdapter(spawn);
    await adapter.open("pwd", "window");
    expect(spawn.calls[0].args[2]).toContain("do script");
    expect(spawn.calls[0].args[2]).not.toContain("New Tab");
  });
});

describe("TmuxAdapter", () => {
  test("opens tab with tmux new-window", async () => {
    const spawn = mockSpawn();
    const adapter = new TmuxAdapter(spawn);
    await adapter.open("vim", "tab");
    expect(spawn.calls[0].args).toEqual(["tmux", "new-window", "vim"]);
  });

  test("opens window with tmux new-session", async () => {
    const spawn = mockSpawn();
    const adapter = new TmuxAdapter(spawn);
    await adapter.open("vim", "window");
    expect(spawn.calls[0].args).toEqual(["tmux", "new-session", "-d", "vim"]);
  });
});

describe("KittyAdapter", () => {
  test("opens tab with kitten", async () => {
    const spawn = mockSpawn();
    const adapter = new KittyAdapter(spawn);
    await adapter.open("htop", "tab");
    expect(spawn.calls[0].args).toEqual(["kitten", "@", "launch", "--type=tab", "--copy-env", "sh", "-c", "htop"]);
  });

  test("opens window with kitten", async () => {
    const spawn = mockSpawn();
    const adapter = new KittyAdapter(spawn);
    await adapter.open("htop", "window");
    expect(spawn.calls[0].args).toContain("--type=os-window");
  });
});

describe("WeztermAdapter", () => {
  test("opens tab with wezterm cli", async () => {
    const spawn = mockSpawn();
    const adapter = new WeztermAdapter(spawn);
    await adapter.open("node", "tab");
    expect(spawn.calls[0].args).toEqual(["wezterm", "cli", "spawn", "--new-window=false", "--", "sh", "-c", "node"]);
  });

  test("opens window with wezterm cli", async () => {
    const spawn = mockSpawn();
    const adapter = new WeztermAdapter(spawn);
    await adapter.open("node", "window");
    expect(spawn.calls[0].args).toContain("--new-window=true");
  });
});

// -- spawnHeadless --

describe("spawnHeadless", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mcp-tty-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("spawns command and returns pid + logFile", async () => {
    const spawn = mock((cmd: string, logFile: string) => ({
      pid: 42,
      unref: mock(() => {}),
    }));

    const result = await spawnHeadless("sleep 10", spawn, testDir);
    expect(result.pid).toBe(42);
    expect(result.logFile).toContain(testDir);
    expect(result.logFile).toMatch(/\.log$/);
  });

  test("creates logs directory if missing", async () => {
    const spawn = mock(() => ({ pid: 1, unref: mock(() => {}) }));

    expect(existsSync(testDir)).toBe(false);
    await spawnHeadless("echo hi", spawn, testDir);
    expect(existsSync(testDir)).toBe(true);
  });

  test("calls unref on spawned process", async () => {
    const unref = mock(() => {});
    const spawn = mock(() => ({ pid: 1, unref }));

    await spawnHeadless("echo hi", spawn, testDir);
    expect(unref).toHaveBeenCalled();
  });
});

// -- cmdTty --

describe("cmdTty", () => {
  test("shows usage with no args", async () => {
    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await cmdTty([]);
      expect(logSpy).toHaveBeenCalled();
      const output = (logSpy.mock.calls[0] as string[])[0];
      expect(output).toContain("mcx tty open");
    } finally {
      console.log = origLog;
    }
  });

  test("errors on unknown subcommand", async () => {
    const deps = makeDeps();
    await expect(cmdTty(["unknown"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("Unknown tty subcommand"));
  });
});

// -- ttyOpen --

describe("ttyOpen", () => {
  test("opens in configured terminal (tab)", async () => {
    const mockAdapter: TerminalAdapter = {
      name: "MockTerm",
      open: mock(async () => {}),
    };
    const deps = makeDeps({
      readCliConfig: () => ({ terminal: "ghostty" }),
      getAdapter: mock(() => mockAdapter),
    });

    await ttyOpen(["echo hello"], deps);

    expect(deps.getAdapter).toHaveBeenCalledWith("ghostty");
    expect(mockAdapter.open).toHaveBeenCalledWith("echo hello", "tab");
  });

  test("opens in window mode", async () => {
    const mockAdapter: TerminalAdapter = {
      name: "MockTerm",
      open: mock(async () => {}),
    };
    const deps = makeDeps({
      readCliConfig: () => ({ terminal: "tmux" }),
      getAdapter: mock(() => mockAdapter),
    });

    await ttyOpen(["--window", "bun", "test"], deps);

    expect(deps.getAdapter).toHaveBeenCalledWith("tmux");
    expect(mockAdapter.open).toHaveBeenCalledWith("bun test", "window");
  });

  test("falls back to auto-detect when no config", async () => {
    const mockAdapter: TerminalAdapter = {
      name: "MockTerm",
      open: mock(async () => {}),
    };
    const deps = makeDeps({
      readCliConfig: () => ({}),
      detectTerminal: () => "iterm",
      getAdapter: mock(() => mockAdapter),
    });

    await ttyOpen(["ls -la"], deps);

    expect(deps.getAdapter).toHaveBeenCalledWith("iterm");
  });

  test("errors when no terminal configured and auto-detect fails", async () => {
    const deps = makeDeps({
      readCliConfig: () => ({}),
      detectTerminal: () => undefined,
    });

    await expect(ttyOpen(["ls"], deps)).rejects.toThrow(ExitError);
    expect(deps.printError).toHaveBeenCalledWith(expect.stringContaining("No terminal configured"));
  });

  test("headless mode spawns background process", async () => {
    const deps = makeDeps();

    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await ttyOpen(["--headless", "sleep", "10"], deps);

      expect(deps.spawnHeadless).toHaveBeenCalledWith("sleep 10");
      const output = JSON.parse((logSpy.mock.calls[0] as string[])[0]);
      expect(output).toEqual({ pid: 12345, logFile: "/tmp/test.log" });
    } finally {
      console.log = origLog;
    }
  });

  test("shows usage when no command given", async () => {
    const logSpy = mock(() => {});
    const origLog = console.log;
    console.log = logSpy;
    try {
      await ttyOpen([]);
      expect(logSpy).toHaveBeenCalled();
      const output = (logSpy.mock.calls[0] as string[])[0];
      expect(output).toContain("mcx tty open");
    } finally {
      console.log = origLog;
    }
  });
});
