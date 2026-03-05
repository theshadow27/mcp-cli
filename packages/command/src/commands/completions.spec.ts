import { describe, expect, mock, test } from "bun:test";
import {
  ALIAS_SUBCOMMANDS,
  CONFIG_SUBCOMMANDS,
  SUBCOMMANDS,
  bashScript,
  cmdCompletions,
  fishScript,
  zshScript,
} from "./completions";

describe("SUBCOMMANDS", () => {
  const expected = [
    "ls",
    "call",
    "info",
    "grep",
    "status",
    "config",
    "add",
    "add-json",
    "remove",
    "get",
    "auth",
    "alias",
    "run",
    "logs",
    "typegen",
    "restart",
    "shutdown",
    "tools",
    "search",
    "install",
    "registry",
    "completions",
    "help",
  ];

  test("contains all expected commands", () => {
    for (const cmd of expected) {
      expect((SUBCOMMANDS as readonly string[]).includes(cmd)).toBe(true);
    }
  });

  test("has no unexpected commands", () => {
    expect(SUBCOMMANDS).toHaveLength(expected.length);
  });
});

describe("ALIAS_SUBCOMMANDS", () => {
  test("contains ls, save, show, edit, rm", () => {
    expect([...ALIAS_SUBCOMMANDS]).toEqual(["ls", "save", "show", "edit", "rm"]);
  });
});

describe("CONFIG_SUBCOMMANDS", () => {
  test("contains show, sources, set, and get", () => {
    expect([...CONFIG_SUBCOMMANDS]).toEqual(["show", "sources", "set", "get"]);
  });
});

describe("bashScript", () => {
  const script = bashScript();

  test("defines the completion function", () => {
    expect(script).toContain("_mcp_completions()");
  });

  test("registers with complete builtin", () => {
    expect(script).toContain("complete -F _mcp_completions mcp");
  });

  test("calls back for dynamic server names", () => {
    expect(script).toContain("mcp completions --servers 2>/dev/null");
  });

  test("calls back for dynamic tool names", () => {
    expect(script).toContain("mcp completions --tools");
  });

  test("calls back for dynamic alias names", () => {
    expect(script).toContain("mcp completions --aliases 2>/dev/null");
  });

  test("contains all subcommands", () => {
    for (const cmd of SUBCOMMANDS) {
      expect(script).toContain(cmd);
    }
  });
});

describe("zshScript", () => {
  const script = zshScript();

  test("starts with #compdef directive", () => {
    expect(script).toMatch(/^#compdef mcp/);
  });

  test("defines the _mcp function", () => {
    expect(script).toContain("_mcp()");
  });

  test("uses _describe for completions", () => {
    expect(script).toContain("_describe");
  });

  test("calls back for dynamic server names", () => {
    expect(script).toContain("mcp completions --servers 2>/dev/null");
  });

  test("calls back for dynamic tool names", () => {
    expect(script).toContain("mcp completions --tools");
  });

  test("calls back for dynamic alias names", () => {
    expect(script).toContain("mcp completions --aliases 2>/dev/null");
  });

  test("contains all subcommands", () => {
    for (const cmd of SUBCOMMANDS) {
      expect(script).toContain(cmd);
    }
  });
});

describe("fishScript", () => {
  const script = fishScript();

  test("uses complete -c mcp", () => {
    expect(script).toContain("complete -c mcp");
  });

  test("disables file completions", () => {
    expect(script).toContain("complete -c mcp -f");
  });

  test("calls back for dynamic server names", () => {
    expect(script).toContain("mcp completions --servers 2>/dev/null");
  });

  test("calls back for dynamic tool names", () => {
    expect(script).toContain("mcp completions --tools");
  });

  test("calls back for dynamic alias names", () => {
    expect(script).toContain("mcp completions --aliases 2>/dev/null");
  });

  test("contains all subcommands in initial completion", () => {
    expect(script).toContain(SUBCOMMANDS.join(" "));
  });
});

describe("daemon guard", () => {
  test("completion helpers do not call ipcCall when daemon is not running", async () => {
    const ipcCallMock = mock(() => Promise.resolve([]));
    const isDaemonRunningMock = mock(() => Promise.resolve(false));
    const deps = { ipcCall: ipcCallMock, isDaemonRunning: isDaemonRunningMock };

    // --servers
    await cmdCompletions(["--servers"], deps);
    expect(isDaemonRunningMock).toHaveBeenCalled();
    expect(ipcCallMock).not.toHaveBeenCalled();

    // Reset
    isDaemonRunningMock.mockClear();
    ipcCallMock.mockClear();

    // --tools
    await cmdCompletions(["--tools", "some-server"], deps);
    expect(isDaemonRunningMock).toHaveBeenCalled();
    expect(ipcCallMock).not.toHaveBeenCalled();

    // Reset
    isDaemonRunningMock.mockClear();
    ipcCallMock.mockClear();

    // --aliases
    await cmdCompletions(["--aliases"], deps);
    expect(isDaemonRunningMock).toHaveBeenCalled();
    expect(ipcCallMock).not.toHaveBeenCalled();
  });
});

describe("cross-script consistency", () => {
  const scripts = [
    { name: "bash", fn: bashScript },
    { name: "zsh", fn: zshScript },
    { name: "fish", fn: fishScript },
  ];

  for (const { name, fn } of scripts) {
    test(`${name} references --servers`, () => {
      expect(fn()).toContain("--servers");
    });

    test(`${name} references --tools`, () => {
      expect(fn()).toContain("--tools");
    });

    test(`${name} references --aliases`, () => {
      expect(fn()).toContain("--aliases");
    });

    test(`${name} suppresses stderr with 2>/dev/null`, () => {
      expect(fn()).toContain("2>/dev/null");
    });
  }
});
