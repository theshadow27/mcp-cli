import { describe, expect, mock, test } from "bun:test";
import type { CompletionDeps } from "./completions";
import {
  AGENT_PROVIDERS,
  AGENT_SUBCOMMANDS,
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
    "serve",
    "mail",
    "import",
    "export",
    "help",
    "agent",
    "claude",
  ];

  test("contains all expected commands", () => {
    for (const cmd of expected) {
      expect((SUBCOMMANDS as readonly string[]).includes(cmd)).toBe(true);
    }
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

describe("AGENT_SUBCOMMANDS", () => {
  test("contains all agent subcommands", () => {
    expect([...AGENT_SUBCOMMANDS]).toEqual([
      "spawn",
      "ls",
      "send",
      "bye",
      "wait",
      "interrupt",
      "log",
      "resume",
      "worktrees",
    ]);
  });
});

describe("AGENT_PROVIDERS", () => {
  test("contains known providers", () => {
    expect([...AGENT_PROVIDERS]).toEqual(["claude", "codex", "opencode", "acp"]);
  });
});

describe("bashScript", () => {
  const script = bashScript();

  test("defines the completion function", () => {
    expect(script).toContain("_mcx_completions()");
  });

  test("registers with complete builtin", () => {
    expect(script).toContain("complete -F _mcx_completions mcx");
  });

  test("calls back for dynamic server names", () => {
    expect(script).toContain("mcx completions --servers 2>/dev/null");
  });

  test("calls back for dynamic tool names", () => {
    expect(script).toContain("mcx completions --tools");
  });

  test("calls back for dynamic alias names", () => {
    expect(script).toContain("mcx completions --aliases 2>/dev/null");
  });

  test("calls back for registry slugs on install", () => {
    expect(script).toContain("mcx completions --registry 2>/dev/null");
  });

  test("contains all subcommands", () => {
    for (const cmd of SUBCOMMANDS) {
      expect(script).toContain(cmd);
    }
  });

  test("completes claude subcommands", () => {
    for (const sub of AGENT_SUBCOMMANDS) {
      expect(script).toContain(sub);
    }
  });

  test("completes agent providers", () => {
    for (const p of AGENT_PROVIDERS) {
      expect(script).toContain(p);
    }
  });
});

describe("zshScript", () => {
  const script = zshScript();

  test("starts with #compdef directive", () => {
    expect(script).toMatch(/^#compdef mcx/);
  });

  test("defines the _mcx function", () => {
    expect(script).toContain("_mcx()");
  });

  test("uses _describe for completions", () => {
    expect(script).toContain("_describe");
  });

  test("calls back for dynamic server names", () => {
    expect(script).toContain("mcx completions --servers 2>/dev/null");
  });

  test("calls back for dynamic tool names", () => {
    expect(script).toContain("mcx completions --tools");
  });

  test("calls back for dynamic alias names", () => {
    expect(script).toContain("mcx completions --aliases 2>/dev/null");
  });

  test("calls back for registry slugs on install", () => {
    expect(script).toContain("mcx completions --registry 2>/dev/null");
  });

  test("contains all subcommands", () => {
    for (const cmd of SUBCOMMANDS) {
      expect(script).toContain(cmd);
    }
  });

  test("completes claude subcommands", () => {
    for (const sub of AGENT_SUBCOMMANDS) {
      expect(script).toContain(sub);
    }
  });

  test("completes agent providers", () => {
    for (const p of AGENT_PROVIDERS) {
      expect(script).toContain(p);
    }
  });
});

describe("fishScript", () => {
  const script = fishScript();

  test("uses complete -c mcx", () => {
    expect(script).toContain("complete -c mcx");
  });

  test("disables file completions", () => {
    expect(script).toContain("complete -c mcx -f");
  });

  test("calls back for dynamic server names", () => {
    expect(script).toContain("mcx completions --servers 2>/dev/null");
  });

  test("calls back for dynamic tool names", () => {
    expect(script).toContain("mcx completions --tools");
  });

  test("calls back for dynamic alias names", () => {
    expect(script).toContain("mcx completions --aliases 2>/dev/null");
  });

  test("calls back for registry slugs on install", () => {
    expect(script).toContain("mcx completions --registry 2>/dev/null");
  });

  test("contains all subcommands in initial completion", () => {
    expect(script).toContain(SUBCOMMANDS.join(" "));
  });

  test("completes claude subcommands", () => {
    expect(script).toContain(`__mcx_token 2 = claude' -a '${AGENT_SUBCOMMANDS.join(" ")}'`);
  });

  test("completes agent providers", () => {
    expect(script).toContain(`__mcx_token 2 = agent' -a '${AGENT_PROVIDERS.join(" ")}'`);
  });

  test("completes agent provider subcommands", () => {
    for (const p of AGENT_PROVIDERS) {
      expect(script).toContain(`__mcx_token 3 = ${p}`);
    }
  });
});

describe("--registry helper", () => {
  function makeDeps(registryResult: unknown): CompletionDeps {
    return {
      ipcCall: mock(() => Promise.resolve([])) as CompletionDeps["ipcCall"],
      isDaemonRunning: mock(() => Promise.resolve(false)),
      listRegistry: mock(() => Promise.resolve(registryResult)),
    } as CompletionDeps;
  }

  test("prints slugs from registry response", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      const deps = makeDeps({
        servers: [
          { _meta: { "com.anthropic.api/mcp-registry": { slug: "server-a" } } },
          { _meta: { "com.anthropic.api/mcp-registry": { slug: "server-b" } } },
        ],
        metadata: { count: 2 },
      });
      await cmdCompletions(["--registry"], deps);
      expect(logs).toEqual(["server-a", "server-b"]);
    } finally {
      console.log = origLog;
    }
  });

  test("outputs nothing on network error", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      const deps = makeDeps(null);
      // Override to throw
      deps.listRegistry = mock(() => Promise.reject(new Error("network"))) as CompletionDeps["listRegistry"];
      await cmdCompletions(["--registry"], deps);
      expect(logs).toEqual([]);
    } finally {
      console.log = origLog;
    }
  });
});

describe("daemon guard", () => {
  test("completion helpers do not call ipcCall when daemon is not running", async () => {
    const ipcCallMock = mock(() => Promise.resolve([]));
    const isDaemonRunningMock = mock(() => Promise.resolve(false));
    const listRegistryMock = mock(() => Promise.resolve({ servers: [], metadata: { count: 0 } }));
    const deps = {
      ipcCall: ipcCallMock as CompletionDeps["ipcCall"],
      isDaemonRunning: isDaemonRunningMock,
      listRegistry: listRegistryMock as CompletionDeps["listRegistry"],
    };

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

    test(`${name} references --registry`, () => {
      expect(fn()).toContain("--registry");
    });

    test(`${name} suppresses stderr with 2>/dev/null`, () => {
      expect(fn()).toContain("2>/dev/null");
    });
  }
});
