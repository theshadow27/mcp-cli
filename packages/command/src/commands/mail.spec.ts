import { describe, expect, test } from "bun:test";
import type { IpcMethod, MailMessage } from "@mcp-cli/core";
import { restoreEnv, unsetEnv } from "../../../../test/env";
import type { MailDeps } from "./mail";
import { cmdMail, defaultSenderName, parseMailArgs } from "./mail";

interface TestState {
  stdout: string;
  stderr: string;
  errors: string[];
  exitCode: number | undefined;
}

function testDeps(overrides?: Partial<MailDeps>): MailDeps & { state: TestState } {
  const state: TestState = { stdout: "", stderr: "", errors: [], exitCode: undefined };
  const deps: MailDeps = {
    ipcCall: (async () => ({})) as MailDeps["ipcCall"],
    printError: (msg: string) => state.errors.push(msg),
    writeStdout: (msg: string) => {
      state.stdout += msg;
    },
    writeStderr: (msg: string) => {
      state.stderr += msg;
    },
    readStdin: async () => "",
    isTTY: true,
    defaultSender: "testuser",
    cwd: "/test/cwd",
    exit: (code: number) => {
      state.exitCode = code;
      throw new Error(`exit(${code})`);
    },
    now: () => Date.now(),
    sleep: async () => {},
    ...overrides,
  };
  return Object.assign(deps, { state });
}

describe("parseMailArgs", () => {
  test("parses -s subject", () => {
    const args = parseMailArgs(["-s", "hello", "manager"]);
    expect(args.subject).toBe("hello");
    expect(args.recipient).toBe("manager");
    expect(args.error).toBeUndefined();
  });

  test("parses -H flag", () => {
    const args = parseMailArgs(["-H"]);
    expect(args.headersOnly).toBe(true);
  });

  test("parses -u user", () => {
    const args = parseMailArgs(["-u", "wt-262"]);
    expect(args.user).toBe("wt-262");
  });

  test("parses -r msgnum", () => {
    const args = parseMailArgs(["-r", "42"]);
    expect(args.replyTo).toBe(42);
  });

  test("parses -N flag", () => {
    const args = parseMailArgs(["-N"]);
    expect(args.suppressHeaders).toBe(true);
  });

  test("parses --wait", () => {
    const args = parseMailArgs(["--wait"]);
    expect(args.wait).toBe(true);
    expect(args.timeout).toBe(180);
  });

  test("parses --timeout=N", () => {
    const args = parseMailArgs(["--wait", "--timeout=60"]);
    expect(args.wait).toBe(true);
    expect(args.timeout).toBe(60);
  });

  test("parses --timeout N (space-separated)", () => {
    const args = parseMailArgs(["--wait", "--timeout", "90"]);
    expect(args.timeout).toBe(90);
  });

  test("parses --for=name", () => {
    const args = parseMailArgs(["--wait", "--for=wt-262"]);
    expect(args.forRecipient).toBe("wt-262");
  });

  test("parses --for name (space-separated)", () => {
    const args = parseMailArgs(["--wait", "--for", "wt-262"]);
    expect(args.forRecipient).toBe("wt-262");
  });

  test("parses --from=name", () => {
    const args = parseMailArgs(["--from=bot", "-s", "hi", "manager"]);
    expect(args.from).toBe("bot");
  });

  test("parses --from name (space-separated)", () => {
    const args = parseMailArgs(["--from", "bot", "-s", "hi", "manager"]);
    expect(args.from).toBe("bot");
  });

  test("error on -s without value", () => {
    const args = parseMailArgs(["-s"]);
    expect(args.error).toBe("-s requires a subject");
  });

  test("error on -u without value", () => {
    const args = parseMailArgs(["-u"]);
    expect(args.error).toBe("-u requires a username");
  });

  test("error on -r without value", () => {
    const args = parseMailArgs(["-r"]);
    expect(args.error).toBe("-r requires a message number");
  });

  test("error on -r with non-number", () => {
    const args = parseMailArgs(["-r", "abc"]);
    expect(args.error).toBe("-r requires a message number");
  });

  test("error on --timeout with invalid value", () => {
    const args = parseMailArgs(["--timeout=0"]);
    expect(args.error).toBe("--timeout requires a positive number");
  });

  test("error on --for without value", () => {
    const args = parseMailArgs(["--for"]);
    expect(args.error).toBe("--for requires a recipient name");
  });

  test("error on --from without value", () => {
    const args = parseMailArgs(["--from"]);
    expect(args.error).toBe("--from requires a sender name");
  });

  // #3038
  test("parses -d domain and --domain=name", () => {
    expect(parseMailArgs(["-d", "phoenix", "-s", "hi", "boss"]).domain).toBe("phoenix");
    expect(parseMailArgs(["--domain=phoenix", "-H"]).domain).toBe("phoenix");
  });

  test("domain is undefined when -d is absent — the daemon resolves cwd, not the CLI", () => {
    expect(parseMailArgs(["-s", "hi", "boss"]).domain).toBeUndefined();
  });

  test("error on -d without value", () => {
    expect(parseMailArgs(["-d"]).error).toBe("-d requires a domain name");
  });

  test("a user@domain recipient is passed through verbatim for the daemon to resolve", () => {
    // The CLI does not parse the address: the domains table lives in the daemon, and
    // splitting here would mean two implementations of the last-@ rule.
    expect(parseMailArgs(["-s", "hi", "orchestrator@phoenix"]).recipient).toBe("orchestrator@phoenix");
  });

  /**
   * `-d` and `--domain` are one flag with two spellings, and both must behave
   * identically in every position.
   *
   * Asserting only `.domain` would be asserting the column instead of the constraint:
   * if `-d` were ever mis-specced as a boolean, its value would fall through to
   * `positionals[0]` and become the *recipient* — `mcx mail -d phoenix -s hi boss`
   * would silently send to `phoenix` and drop `boss`, while a `.domain`-only
   * assertion stayed green. So each case pins the recipient too.
   *
   * This is the `mcx claude bye --all` defect class: two spellings of one flag doing
   * different things, with no test that exercised both.
   */
  test("-d and --domain are interchangeable and never swallow the recipient", () => {
    const cases: string[][] = [
      ["-d", "phoenix", "-s", "hi", "boss"],
      ["--domain", "phoenix", "-s", "hi", "boss"],
      ["--domain=phoenix", "-s", "hi", "boss"],
      ["-s", "hi", "-d", "phoenix", "boss"],
      ["-s", "hi", "boss", "-d", "phoenix"],
      ["-s", "hi", "boss", "--domain=phoenix"],
    ];
    for (const argv of cases) {
      const args = parseMailArgs(argv);
      expect({ argv, domain: args.domain, recipient: args.recipient, error: args.error }).toEqual({
        argv,
        domain: "phoenix",
        recipient: "boss",
        error: undefined,
      });
    }
  });

  test("-d does not shadow the other flags' values in any position", () => {
    expect(parseMailArgs(["-d", "phoenix", "-u", "boss"]).user).toBe("boss");
    expect(parseMailArgs(["-d", "phoenix", "-r", "7"]).replyTo).toBe(7);
    expect(parseMailArgs(["-d", "phoenix", "--wait", "--for=boss"]).forRecipient).toBe("boss");
    expect(parseMailArgs(["-d", "phoenix", "--from=bot", "-s", "x", "boss"]).from).toBe("bot");
  });

  test("both spellings resolve last-wins when repeated or mixed", () => {
    // Neither spelling gets priority over the other — only position decides.
    expect(parseMailArgs(["-d", "alpha", "--domain", "beta", "-s", "x", "b"]).domain).toBe("beta");
    expect(parseMailArgs(["--domain", "beta", "-d", "alpha", "-s", "x", "b"]).domain).toBe("alpha");
    expect(parseMailArgs(["-d", "alpha", "-d", "beta", "-s", "x", "b"]).domain).toBe("beta");
  });

  test("a valueless -d errors in either spelling rather than consuming the next flag", () => {
    expect(parseMailArgs(["-d"]).error).toBe("-d requires a domain name");
    expect(parseMailArgs(["--domain"]).error).toBe("-d requires a domain name");
    expect(parseMailArgs(["-d", "-s"]).error).toBe("-d requires a domain name");
  });
});

describe("cmdMail", () => {
  test("send mode calls sendMail IPC", async () => {
    let ipcParams: unknown;
    const d = testDeps({
      isTTY: false,
      readStdin: async () => "stuck on type error",
      ipcCall: (async (method: IpcMethod, params?: unknown) => {
        ipcParams = params;
        return { id: 1 };
      }) as MailDeps["ipcCall"],
    });

    await cmdMail(["-s", "stuck", "manager"], d);
    expect(ipcParams).toEqual({
      sender: "testuser",
      recipient: "manager",
      subject: "stuck",
      body: "stuck on type error",
      cwd: "/test/cwd",
      domain: undefined,
    });
    expect(d.state.stdout).toContain('"id":1');
  });

  test("send mode uses --from override", async () => {
    let ipcParams: unknown;
    const d = testDeps({
      isTTY: false,
      readStdin: async () => "body",
      ipcCall: (async (_method: IpcMethod, params?: unknown) => {
        ipcParams = params;
        return { id: 1 };
      }) as MailDeps["ipcCall"],
    });

    await cmdMail(["--from=wt-262", "-s", "done", "manager"], d);
    expect((ipcParams as Record<string, unknown>).sender).toBe("wt-262");
  });

  test("read mode shows headers", async () => {
    const msg: MailMessage = {
      id: 1,
      sender: "wt-262",
      recipient: "manager",
      subject: "tests pass",
      body: "All green",
      replyTo: null,
      domainId: 0,
      read: false,
      createdAt: "2025-01-01 00:00:00",
    };
    const d = testDeps({
      ipcCall: (async (method: IpcMethod) => {
        if (method === "readMail") return { messages: [msg] };
        return {};
      }) as MailDeps["ipcCall"],
    });

    await cmdMail(["-H"], d);
    expect(d.state.stdout).toContain("wt-262");
    expect(d.state.stdout).toContain("tests pass");
    expect(d.state.stdout).toContain("N"); // unread marker
  });

  test("read mode shows no mail message", async () => {
    const d = testDeps({
      ipcCall: (async () => ({ messages: [] })) as MailDeps["ipcCall"],
    });

    await cmdMail(["-H"], d);
    expect(d.state.stderr).toContain("No mail");
  });

  test("reply mode calls replyToMail", async () => {
    let ipcParams: unknown;
    const d = testDeps({
      isTTY: false,
      readStdin: async () => "looks good",
      ipcCall: (async (method: IpcMethod, params?: unknown) => {
        if (method === "replyToMail") {
          ipcParams = params;
          return { id: 2 };
        }
        return {};
      }) as MailDeps["ipcCall"],
    });

    await cmdMail(["-r", "1", "-s", "approved"], d);
    expect(ipcParams).toEqual({
      id: 1,
      sender: "testuser",
      body: "looks good",
      subject: "approved",
      cwd: "/test/cwd",
      domain: undefined,
    });
    expect(d.state.stdout).toContain('"id":2');
  });

  // #3038 — every mail call carries a scope. A missing one is refused by the daemon, so
  // a call site that forgot it is a silent no-scope call; these pin all five.
  test("every mail IPC call carries the domain scope", async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    const msg: MailMessage = {
      id: 1,
      sender: "a",
      recipient: "b",
      subject: "s",
      body: "b",
      replyTo: null,
      domainId: 0,
      read: false,
      createdAt: "2025-01-01 00:00:00",
    };
    const makeDeps = () =>
      testDeps({
        isTTY: false,
        readStdin: async () => "body",
        ipcCall: (async (method: IpcMethod, params?: unknown) => {
          seen.push({ method, params: (params ?? {}) as Record<string, unknown> });
          if (method === "readMail") return { messages: [msg] };
          if (method === "waitForMail") return { message: msg };
          return { id: 1 };
        }) as MailDeps["ipcCall"],
      });

    await cmdMail(["-d", "phoenix", "-s", "x", "boss"], makeDeps()); // sendMail
    await cmdMail(["-d", "phoenix", "-r", "1"], makeDeps()); // replyToMail
    await cmdMail(["-d", "phoenix", "-H"], makeDeps()); // readMail (+ markRead)
    await cmdMail(["-d", "phoenix", "--wait", "--timeout=1"], makeDeps()); // waitForMail

    expect(seen.map((s) => s.method).sort()).toEqual(["readMail", "replyToMail", "sendMail", "waitForMail"]);
    for (const { method, params } of seen) {
      expect({ method, cwd: params.cwd, domain: params.domain }).toEqual({
        method,
        cwd: "/test/cwd",
        domain: "phoenix",
      });
    }
  });

  test("markRead from read mode also carries the scope", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const msg: MailMessage = {
      id: 9,
      sender: "a",
      recipient: "b",
      subject: "s",
      body: "unread body",
      replyTo: null,
      domainId: 0,
      read: false,
      createdAt: "2025-01-01 00:00:00",
    };
    const d = testDeps({
      ipcCall: (async (method: IpcMethod, params?: unknown) => {
        if (method === "markRead") seen.push((params ?? {}) as Record<string, unknown>);
        if (method === "readMail") return { messages: [msg] };
        return {};
      }) as MailDeps["ipcCall"],
    });

    await cmdMail(["-d", "phoenix"], d);
    expect(seen).toEqual([{ id: 9, cwd: "/test/cwd", domain: "phoenix" }]);
  });

  test("reply mode requires body", async () => {
    const d = testDeps({
      isTTY: true,
      readStdin: async () => "",
    });

    await expect(cmdMail(["-r", "1"], d)).rejects.toThrow("exit(1)");
    expect(d.state.errors).toContain("Reply body required (pipe via stdin)");
  });

  test("wait mode returns message as JSON", async () => {
    const msg: MailMessage = {
      id: 5,
      sender: "manager",
      recipient: "wt-262",
      subject: "go ahead",
      body: "create the PR",
      replyTo: null,
      domainId: 0,
      read: true,
      createdAt: "2025-01-01 00:00:00",
    };
    const d = testDeps({
      ipcCall: (async () => ({ message: msg })) as MailDeps["ipcCall"],
    });

    await cmdMail(["--wait", "--for=wt-262", "--timeout=5"], d);
    const parsed = JSON.parse(d.state.stdout.trim());
    expect(parsed.id).toBe(5);
    expect(parsed.sender).toBe("manager");
  });

  test("wait mode exits 1 on timeout", async () => {
    let callCount = 0;
    const start = Date.now();
    const d = testDeps({
      now: () => start + callCount * 31_000, // Each call advances 31s past the 30s server timeout
      ipcCall: (async () => {
        callCount++;
        return { message: null };
      }) as MailDeps["ipcCall"],
    });

    await expect(cmdMail(["--wait", "--timeout=5"], d)).rejects.toThrow("exit(1)");
    expect(d.state.stderr).toContain("Timeout");
  });

  test("--help prints usage and returns", async () => {
    const d = testDeps();
    await cmdMail(["--help"], d);
    expect(d.state.stderr).toContain("mcx mail");
    expect(d.state.stderr).toContain("--wait");
    expect(d.state.exitCode).toBeUndefined(); // no exit, just prints
  });

  test("no args prints help instead of silently reading mail", async () => {
    let ipcCallCount = 0;
    const d = testDeps({
      ipcCall: (async () => {
        ipcCallCount++;
        return {};
      }) as MailDeps["ipcCall"],
    });
    await cmdMail([], d);
    expect(d.state.stderr).toContain("mcx mail");
    expect(d.state.stderr).toContain("Recipients are string role-names");
    expect(d.state.exitCode).toBeUndefined();
    expect(ipcCallCount).toBe(0);
  });

  test("help text explains recipient naming conventions", async () => {
    const d = testDeps();
    await cmdMail(["--help"], d);
    expect(d.state.stderr).toContain("orchestrator");
    expect(d.state.stderr).toContain("Mailboxes are created implicitly");
  });

  test("parse error exits with message", async () => {
    const d = testDeps();
    await expect(cmdMail(["-s"], d)).rejects.toThrow("exit(1)");
    expect(d.state.errors).toContain("-s requires a subject");
  });
});

describe("defaultSenderName", () => {
  test("returns USER env var when not CLAUDE", () => {
    const origClaude = process.env.CLAUDE;
    const origUser = process.env.USER;
    unsetEnv("CLAUDE");
    process.env.USER = "jacob";
    try {
      expect(defaultSenderName()).toBe("jacob");
    } finally {
      restoreEnv("CLAUDE", origClaude);
      restoreEnv("USER", origUser);
    }
  });

  test("returns claude-<cwd-basename> when CLAUDE=1", () => {
    const origClaude = process.env.CLAUDE;
    process.env.CLAUDE = "1";
    try {
      const cwd = process.cwd();
      const base = cwd.split("/").pop() ?? "claude";
      expect(defaultSenderName()).toBe(`claude-${base}`);
    } finally {
      restoreEnv("CLAUDE", origClaude);
    }
  });
});
