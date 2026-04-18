import { describe, expect, mock, test } from "bun:test";
import { type SiteDeps, cmdSite } from "./site";

function makeDeps(ipcReply: unknown = { content: [{ type: "text", text: "[]" }] }): {
  deps: SiteDeps;
  calls: Array<{ method: string; params: unknown }>;
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | null = null;
  const deps: SiteDeps = {
    ipcCall: mock(async (method: string, params: unknown) => {
      calls.push({ method, params });
      return ipcReply;
    }) as unknown as SiteDeps["ipcCall"],
    log: (m) => stdout.push(m),
    logError: (m) => stderr.push(m),
    exit: ((code: number) => {
      exitCode = code;
      throw new Error(`__exit_${code}__`);
    }) as SiteDeps["exit"],
  };
  return {
    deps,
    calls,
    stdout,
    stderr,
    get exitCode() {
      return exitCode;
    },
  };
}

function readLastCall(calls: Array<{ method: string; params: unknown }>): {
  method: string;
  params: { server: string; tool: string; arguments: Record<string, unknown> };
} {
  const last = calls[calls.length - 1];
  return {
    method: last.method,
    params: last.params as { server: string; tool: string; arguments: Record<string, unknown> },
  };
}

describe("cmdSite", () => {
  test("help prints when no subcommand", async () => {
    const { deps, stdout, calls } = makeDeps();
    await cmdSite([], deps);
    expect(stdout[0]).toContain("mcx site");
    expect(calls).toHaveLength(0);
  });

  test("list dispatches to site_list", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["list"], deps);
    const { params } = readLastCall(calls);
    expect(params.server).toBe("_site");
    expect(params.tool).toBe("site_list");
  });

  test("show dispatches to site_show with name", async () => {
    const { deps, calls } = makeDeps({ content: [{ type: "text", text: '{"name":"x"}' }] });
    await cmdSite(["show", "x"], deps);
    const { params } = readLastCall(calls);
    expect(params.tool).toBe("site_show");
    expect(params.arguments.name).toBe("x");
  });

  test("add parses --url and --domains as comma list", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["add", "example", "--url", "https://example.com", "--domains", "a.com,b.com"], deps);
    const { params } = readLastCall(calls);
    expect(params.tool).toBe("site_add");
    expect(params.arguments.url).toBe("https://example.com");
    expect(params.arguments.domains).toEqual(["a.com", "b.com"]);
  });

  test("call puts --k v flags into params, --body into body", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["call", "teams", "get_thing", "--id", "42", "--body", "raw=stuff"], deps);
    const { params } = readLastCall(calls);
    expect(params.tool).toBe("site_call");
    expect(params.arguments.call).toBe("get_thing");
    expect(params.arguments.params).toEqual({ id: 42 });
    expect(params.arguments.body).toBe("raw=stuff");
  });

  test("browser with no sites calls site_browser_start with no args", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["browser"], deps);
    const { params } = readLastCall(calls);
    expect(params.tool).toBe("site_browser_start");
    expect(params.arguments).toEqual({});
  });

  test("browser with site names passes sites array", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["browser", "teams", "github"], deps);
    const { params } = readLastCall(calls);
    expect(params.arguments.sites).toEqual(["teams", "github"]);
  });

  test("disconnect dispatches to site_disconnect", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["disconnect"], deps);
    expect(readLastCall(calls).params.tool).toBe("site_disconnect");
  });

  test("unknown subcommand exits with code 1", async () => {
    const { deps, stderr } = makeDeps();
    let caught: unknown;
    try {
      await cmdSite(["bogus"], deps);
    } catch (e) {
      caught = e;
    }
    expect(String(caught)).toContain("__exit_1__");
    expect(stderr.join("\n")).toContain("Unknown subcommand");
  });

  test("remove dispatches to site_remove", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["remove", "x"], deps);
    expect(readLastCall(calls).params.tool).toBe("site_remove");
    expect(readLastCall(calls).params.arguments.name).toBe("x");
  });

  test("rm alias dispatches to site_remove", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["rm", "x"], deps);
    expect(readLastCall(calls).params.tool).toBe("site_remove");
  });

  test("ls alias dispatches to site_list", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["ls"], deps);
    expect(readLastCall(calls).params.tool).toBe("site_list");
  });

  test("calls dispatches to site_calls", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["calls", "teams"], deps);
    expect(readLastCall(calls).params.tool).toBe("site_calls");
    expect(readLastCall(calls).params.arguments.site).toBe("teams");
  });

  test("describe dispatches to site_describe", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["describe", "teams", "get_messages"], deps);
    expect(readLastCall(calls).params.tool).toBe("site_describe");
    expect(readLastCall(calls).params.arguments.call).toBe("get_messages");
  });

  test("add-call dispatches to site_add_call", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["add-call", "teams", "get_x", "--url", "https://t/x", "--method", "GET"], deps);
    expect(readLastCall(calls).params.tool).toBe("site_add_call");
    expect(readLastCall(calls).params.arguments.name).toBe("get_x");
    expect(readLastCall(calls).params.arguments.url).toBe("https://t/x");
  });

  test("remove-call dispatches to site_remove_call", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["remove-call", "teams", "get_x"], deps);
    expect(readLastCall(calls).params.tool).toBe("site_remove_call");
  });

  test("stop alias dispatches to site_disconnect", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["stop"], deps);
    expect(readLastCall(calls).params.tool).toBe("site_disconnect");
  });

  test("sniff with --mode passes mode through", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["sniff", "teams", "--mode", "firehose", "--limit", "5"], deps);
    const { params } = readLastCall(calls);
    expect(params.tool).toBe("site_sniff");
    expect(params.arguments.mode).toBe("firehose");
    expect(params.arguments.limit).toBe(5);
  });

  test("wiggle without site passes empty args", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["wiggle"], deps);
    expect(readLastCall(calls).params.tool).toBe("site_wiggle");
    expect(readLastCall(calls).params.arguments).toEqual({});
  });

  test("wiggle with site passes site arg", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["wiggle", "teams"], deps);
    expect(readLastCall(calls).params.arguments.site).toBe("teams");
  });

  test("eval joins remaining args into code", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["eval", "teams", "document", "title"], deps);
    const { params } = readLastCall(calls);
    expect(params.tool).toBe("site_eval");
    expect(params.arguments.code).toBe("document title");
  });

  test("cold-start without site passes empty args", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["cold-start"], deps);
    expect(readLastCall(calls).params.tool).toBe("site_cold_start");
    expect(readLastCall(calls).params.arguments).toEqual({});
  });

  test("cold-start with site passes site arg", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["cold-start", "teams"], deps);
    expect(readLastCall(calls).params.arguments.site).toBe("teams");
  });

  test("missing required args emit usage error and exit 1", async () => {
    for (const input of [
      ["show"],
      ["calls"],
      ["describe", "x"],
      ["remove"],
      ["call", "x"],
      ["add-call", "x"],
      ["remove-call", "x"],
      ["eval", "x"],
      ["add"],
      ["sniff"],
    ]) {
      const { deps, stderr } = makeDeps();
      let caught: unknown;
      try {
        await cmdSite(input, deps);
      } catch (e) {
        caught = e;
      }
      expect(String(caught)).toContain("__exit_1__");
      expect(stderr.join("\n")).toContain("usage:");
    }
  });

  test("--json flag still prints JSON for string responses", async () => {
    const { deps, stdout } = makeDeps({ content: [{ type: "text", text: "plain-text" }] });
    await cmdSite(["eval", "s", "x", "--json"], deps);
    // When --json is set, even strings are wrapped in JSON.stringify
    expect(stdout[0]).toContain('"plain-text"');
  });

  test("parseKv handles --key=value", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["add", "example", "--url=https://a.com", "--enabled=true"], deps);
    const { params } = readLastCall(calls);
    expect(params.arguments.url).toBe("https://a.com");
    expect(params.arguments.enabled).toBe(true);
  });

  test("parseKv coerces numbers and booleans", async () => {
    const { deps, calls } = makeDeps();
    await cmdSite(["call", "s", "c", "--n", "42", "--b", "true", "--f", "false"], deps);
    const { params } = readLastCall(calls);
    expect(params.arguments.params).toEqual({ n: 42, b: true, f: false });
  });

  test("help subcommand prints help", async () => {
    const { deps, stdout, calls } = makeDeps();
    await cmdSite(["help"], deps);
    expect(stdout[0]).toContain("mcx site");
    expect(calls).toHaveLength(0);
  });

  test("isError result exits with code 1", async () => {
    const { deps, stderr } = makeDeps({ content: [{ type: "text", text: "Error: boom" }], isError: true });
    let caught: unknown;
    try {
      await cmdSite(["list"], deps);
    } catch (e) {
      caught = e;
    }
    expect(String(caught)).toContain("__exit_1__");
    expect(stderr.join("\n")).toContain("Error: boom");
  });
});
