import { describe, expect, test } from "bun:test";
import { parseFlags } from "../flags";

describe("agent-grid run flag parsing", () => {
  function parse(argv: string[]) {
    return parseFlags(argv, {
      providers: { type: "string", alias: "p" },
      version: { type: "string" },
      offline: { type: "boolean" },
      record: { type: "string", alias: "r" },
      "commit-outcome": { type: "boolean" },
      json: { type: "boolean" },
    });
  }

  test("parses --providers with comma-separated values", () => {
    const { flags, errors } = parse(["--providers", "codex,claude"]);
    expect(errors).toEqual([]);
    expect(flags.providers).toBe("codex,claude");
  });

  test("parses -p alias", () => {
    const { flags, errors } = parse(["-p", "mock"]);
    expect(errors).toEqual([]);
    expect(flags.providers).toBe("mock");
  });

  test("parses --version", () => {
    const { flags, errors } = parse(["--version", "2.1.119"]);
    expect(errors).toEqual([]);
    expect(flags.version).toBe("2.1.119");
  });

  test("parses --offline boolean", () => {
    const { flags, errors } = parse(["--offline"]);
    expect(errors).toEqual([]);
    expect(flags.offline).toBe(true);
  });

  test("parses --record with path", () => {
    const { flags, errors } = parse(["--record", "./out.ndjson"]);
    expect(errors).toEqual([]);
    expect(flags.record).toBe("./out.ndjson");
  });

  test("parses -r alias for record", () => {
    const { flags, errors } = parse(["-r", "/tmp/rec.ndjson"]);
    expect(errors).toEqual([]);
    expect(flags.record).toBe("/tmp/rec.ndjson");
  });

  test("parses --commit-outcome boolean", () => {
    const { flags, errors } = parse(["--commit-outcome"]);
    expect(errors).toEqual([]);
    expect(flags["commit-outcome"]).toBe(true);
  });

  test("parses --json boolean", () => {
    const { flags, errors } = parse(["--json"]);
    expect(errors).toEqual([]);
    expect(flags.json).toBe(true);
  });

  test("parses combined flags", () => {
    const { flags, errors } = parse([
      "--providers",
      "codex",
      "--version",
      "0.30.1",
      "--offline",
      "--record",
      "./out.ndjson",
      "--commit-outcome",
      "--json",
    ]);
    expect(errors).toEqual([]);
    expect(flags.providers).toBe("codex");
    expect(flags.version).toBe("0.30.1");
    expect(flags.offline).toBe(true);
    expect(flags.record).toBe("./out.ndjson");
    expect(flags["commit-outcome"]).toBe(true);
    expect(flags.json).toBe(true);
  });

  test("reports unknown flags", () => {
    const { errors } = parse(["--bogus"]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("--bogus");
  });

  test("parses = syntax", () => {
    const { flags, errors } = parse(["--providers=claude,codex"]);
    expect(errors).toEqual([]);
    expect(flags.providers).toBe("claude,codex");
  });

  test("--help flag detected", () => {
    const { help } = parse(["--help"]);
    expect(help).toBe(true);
  });

  test("defaults omitted flags to undefined", () => {
    const { flags, errors } = parse([]);
    expect(errors).toEqual([]);
    expect(flags.providers).toBeUndefined();
    expect(flags.version).toBeUndefined();
    expect(flags.offline).toBeUndefined();
    expect(flags.record).toBeUndefined();
    expect(flags["commit-outcome"]).toBeUndefined();
    expect(flags.json).toBeUndefined();
  });
});

describe("agent-grid provider resolution", () => {
  test("getAllProviders returns registered providers", async () => {
    const { getAllProviders } = await import("@mcp-cli/core");
    const providers = getAllProviders();
    expect(providers.length).toBeGreaterThan(0);
    const names = providers.map((p) => p.name);
    expect(names).toContain("claude");
    expect(names).toContain("mock");
  });

  test("getProvider returns undefined for unknown provider", async () => {
    const { getProvider } = await import("@mcp-cli/core");
    expect(getProvider("nonexistent-provider")).toBeUndefined();
  });
});

describe("agent-grid gating integration", () => {
  test("gateTest skips when provider lacks features", async () => {
    const { getProvider } = await import("@mcp-cli/core");
    const { gateTest } = await import("@mcp-cli/agent-grid");
    const codex = getProvider("codex");
    if (!codex) throw new Error("codex not registered");

    const test = {
      name: "needs-worktree",
      requires: ["worktree" as const],
      run: async () => ({ status: "pass" as const }),
    };
    const result = gateTest(test, codex);
    expect(result).not.toBeNull();
    expect(result?.status).toBe("n/a");
  });

  test("gateTest allows when provider has features", async () => {
    const { getProvider } = await import("@mcp-cli/core");
    const { gateTest } = await import("@mcp-cli/agent-grid");
    const claude = getProvider("claude");
    if (!claude) throw new Error("claude not registered");

    const test = {
      name: "needs-worktree",
      requires: ["worktree" as const],
      run: async () => ({ status: "pass" as const }),
    };
    expect(gateTest(test, claude)).toBeNull();
  });
});
