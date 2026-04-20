import { describe, expect, test } from "bun:test";
import type { IpcMethod, MailMessage } from "@mcp-cli/core";
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
    });
    expect(d.state.stdout).toContain('"id":2');
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
    const d = testDeps();
    await cmdMail([], d);
    expect(d.state.stderr).toContain("mcx mail");
    expect(d.state.stderr).toContain("Recipients are string role-names");
    expect(d.state.exitCode).toBeUndefined();
  });

  test("help text explains recipient naming conventions", async () => {
    const d = testDeps();
    await cmdMail(["--help"], d);
    expect(d.state.stderr).toContain("orchestrator");
    expect(d.state.stderr).toContain("MCX_AGENT_NAME");
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
    process.env.CLAUDE = undefined;
    process.env.USER = "jacob";
    try {
      expect(defaultSenderName()).toBe("jacob");
    } finally {
      if (origClaude !== undefined) process.env.CLAUDE = origClaude;
      else process.env.CLAUDE = undefined;
      if (origUser !== undefined) process.env.USER = origUser;
      else process.env.USER = undefined;
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
      if (origClaude !== undefined) process.env.CLAUDE = origClaude;
      else process.env.CLAUDE = undefined;
    }
  });
});
