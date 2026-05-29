import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { GridTest } from "@mcp-cli/agent-grid";
import { gateTest } from "@mcp-cli/agent-grid";
import { type AgentProvider, getProvider } from "@mcp-cli/core";
import {
  type GridRunReport,
  type RunOptions,
  cmdAgentGrid,
  discoverTests,
  formatReportText,
  parseRunArgs,
  resolveProviders,
  runGridForProvider,
} from "./agent-grid";

// ── Helpers ────────────────────────────────────────────────────────

function mustParse(argv: string[]): RunOptions {
  const opts = parseRunArgs(argv);
  if (!opts) throw new Error("parseRunArgs returned null");
  return opts;
}

function mustGetProvider(name: string): AgentProvider {
  const p = getProvider(name);
  if (!p) throw new Error(`provider "${name}" not registered`);
  return p;
}

describe("parseRunArgs", () => {
  test("returns null on --help", () => {
    expect(parseRunArgs(["--help"])).toBeNull();
  });

  test("parses --providers with comma-separated values", () => {
    expect(mustParse(["--providers", "codex,claude"]).providers).toEqual(["codex", "claude"]);
  });

  test("parses -p alias", () => {
    expect(mustParse(["-p", "mock"]).providers).toEqual(["mock"]);
  });

  test("parses --version", () => {
    expect(mustParse(["--version", "2.1.119"]).version).toBe("2.1.119");
  });

  test("parses --offline boolean", () => {
    expect(mustParse(["--offline"]).offline).toBe(true);
  });

  test("parses --record with path", () => {
    expect(mustParse(["--record", "./out.ndjson"]).record).toBe("./out.ndjson");
  });

  test("parses -r alias for record", () => {
    expect(mustParse(["-r", "/tmp/rec.ndjson"]).record).toBe("/tmp/rec.ndjson");
  });

  test("parses --commit-outcome boolean", () => {
    expect(mustParse(["--commit-outcome"]).commitOutcome).toBe(true);
  });

  test("parses --json boolean", () => {
    expect(mustParse(["--json"]).json).toBe(true);
  });

  test("parses combined flags", () => {
    const opts = mustParse([
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
    expect(opts.providers).toEqual(["codex"]);
    expect(opts.version).toBe("0.30.1");
    expect(opts.offline).toBe(true);
    expect(opts.record).toBe("./out.ndjson");
    expect(opts.commitOutcome).toBe(true);
    expect(opts.json).toBe(true);
  });

  test("parses = syntax", () => {
    expect(mustParse(["--providers=claude,codex"]).providers).toEqual(["claude", "codex"]);
  });

  test("defaults omitted flags", () => {
    const opts = mustParse([]);
    expect(opts.providers).toEqual([]);
    expect(opts.version).toBeNull();
    expect(opts.offline).toBe(false);
    expect(opts.record).toBeNull();
    expect(opts.commitOutcome).toBe(false);
    expect(opts.json).toBe(false);
  });
});

// ── resolveProviders ───────────────────────────────────────────────

describe("resolveProviders", () => {
  test("default excludes mock", () => {
    const providers = resolveProviders([]);
    const names = providers.map((p) => p.name);
    expect(names).not.toContain("mock");
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain("claude");
  });

  test("explicit --providers=mock is allowed", () => {
    const providers = resolveProviders(["mock"]);
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe("mock");
  });

  test("resolves multiple named providers", () => {
    const providers = resolveProviders(["claude", "codex"]);
    expect(providers).toHaveLength(2);
    expect(providers[0].name).toBe("claude");
    expect(providers[1].name).toBe("codex");
  });
});

// ── discoverTests ──────────────────────────────────────────────────

describe("discoverTests", () => {
  test("returns empty array (skeleton)", () => {
    expect(discoverTests()).toEqual([]);
  });
});

// ── runGridForProvider ─────────────────────────────────────────────

describe("runGridForProvider", () => {
  const defaultOpts = { version: null, record: null, offline: false };

  test("returns empty outcomes for empty test suite", async () => {
    const claude = mustGetProvider("claude");
    const report = await runGridForProvider(claude, [], defaultOpts);
    expect(report.provider).toBe("claude");
    expect(report.outcomes).toEqual([]);
    expect(report.summary).toEqual({ pass: 0, fail: 0, na: 0 });
  });

  test("records version in report", async () => {
    const claude = mustGetProvider("claude");
    const report = await runGridForProvider(claude, [], { ...defaultOpts, version: "2.1.119" });
    expect(report.version).toBe("2.1.119");
  });

  test("gates tests by provider capabilities", async () => {
    const codex = mustGetProvider("codex");
    const gridTest: GridTest = {
      name: "needs-worktree",
      requires: ["worktree"],
      run: async () => ({ status: "pass" }),
    };
    const report = await runGridForProvider(codex, [gridTest], defaultOpts);
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0].result.status).toBe("n/a");
  });

  test("runs passing test", async () => {
    const claude = mustGetProvider("claude");
    const gridTest: GridTest = {
      name: "always-pass",
      requires: [],
      run: async () => ({ status: "pass" }),
    };
    const report = await runGridForProvider(claude, [gridTest], defaultOpts);
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0].result.status).toBe("pass");
    expect(report.summary.pass).toBe(1);
  });

  test("catches test that throws", async () => {
    const claude = mustGetProvider("claude");
    const gridTest: GridTest = {
      name: "throw-test",
      requires: [],
      run: async () => {
        throw new Error("boom");
      },
    };
    const report = await runGridForProvider(claude, [gridTest], defaultOpts);
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0].result.status).toBe("fail");
    expect((report.outcomes[0].result as { error: string }).error).toBe("boom");
    expect(report.summary.fail).toBe(1);
  });

  test("aggregates mixed results", async () => {
    const claude = mustGetProvider("claude");
    const tests: GridTest[] = [
      { name: "pass-test", requires: [], run: async () => ({ status: "pass" }) },
      { name: "fail-test", requires: [], run: async () => ({ status: "fail", error: "bad" }) },
      { name: "gated-test", requires: ["agentSelect"], run: async () => ({ status: "pass" }) },
    ];
    const report = await runGridForProvider(claude, tests, defaultOpts);
    expect(report.summary).toEqual({ pass: 1, fail: 1, na: 1 });
  });

  test("provides cwd to test runner", async () => {
    let receivedCwd = "";
    const claude = mustGetProvider("claude");
    const gridTest: GridTest = {
      name: "cwd-check",
      requires: [],
      run: async (ctx) => {
        receivedCwd = ctx.cwd;
        return { status: "pass" };
      },
    };
    await runGridForProvider(claude, [gridTest], defaultOpts);
    expect(receivedCwd).toContain("agent-grid-claude-");
  });
});

// ── formatReportText ───────────────────────────────────────────────

describe("formatReportText", () => {
  test("no providers message", () => {
    const report: GridRunReport = { providers: [], elapsed_ms: 10 };
    expect(formatReportText(report)).toContain("No providers selected.");
  });

  test("shows (no tests registered) for empty outcomes", () => {
    const report: GridRunReport = {
      providers: [
        {
          provider: "claude",
          version: null,
          outcomes: [],
          summary: { pass: 0, fail: 0, na: 0 },
        },
      ],
      elapsed_ms: 5,
    };
    const text = formatReportText(report);
    expect(text).toContain("claude");
    expect(text).toContain("(no tests registered)");
    expect(text).toContain("elapsed: 5ms");
  });

  test("shows version when present", () => {
    const report: GridRunReport = {
      providers: [
        {
          provider: "codex",
          version: "0.30.1",
          outcomes: [],
          summary: { pass: 0, fail: 0, na: 0 },
        },
      ],
      elapsed_ms: 1,
    };
    expect(formatReportText(report)).toContain("codex@0.30.1");
  });

  test("formats pass/fail/na summary line", () => {
    const report: GridRunReport = {
      providers: [
        {
          provider: "claude",
          version: null,
          outcomes: [
            { test: "t1", result: { status: "pass" } },
            { test: "t2", result: { status: "fail", error: "broke" } },
            { test: "t3", result: { status: "n/a", reason: "missing X" } },
          ],
          summary: { pass: 1, fail: 1, na: 1 },
        },
      ],
      elapsed_ms: 42,
    };
    const text = formatReportText(report);
    expect(text).toContain("1 pass");
    expect(text).toContain("1 fail");
    expect(text).toContain("1 n/a");
    expect(text).toContain("broke");
    expect(text).toContain("missing X");
  });
});

// ── cmdAgentGrid (integration) ─────────────────────────────────────

describe("cmdAgentGrid", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  function stderrLines(): string[] {
    return errorSpy.mock.calls.map((a: unknown[]) => String(a[0]));
  }

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("--help prints to stdout", async () => {
    await cmdAgentGrid(["--help"]);
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain("agent-grid");
  });

  test("no args prints help to stdout", async () => {
    await cmdAgentGrid([]);
    expect(logSpy).toHaveBeenCalled();
  });

  test("run --help prints subcommand help to stdout", async () => {
    await cmdAgentGrid(["run", "--help"]);
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain("agent-grid run");
  });

  test("run with empty suite warns on stderr", async () => {
    await cmdAgentGrid(["run", "--providers=claude", "--json"]);
    expect(stderrLines().some((s: string) => s.includes("no tests registered"))).toBe(true);
  });

  test("run --json outputs valid JSON", async () => {
    await cmdAgentGrid(["run", "--providers=claude", "--json"]);
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.providers).toBeArray();
    expect(parsed.providers[0].provider).toBe("claude");
    expect(parsed.elapsed_ms).toBeNumber();
  });

  test("run text output includes provider name", async () => {
    await cmdAgentGrid(["run", "--providers=codex"]);
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain("codex");
    expect(output).toContain("(no tests registered)");
  });

  test("run --offline warns not yet implemented", async () => {
    await cmdAgentGrid(["run", "--providers=claude", "--offline", "--json"]);
    expect(stderrLines().some((s: string) => s.includes("--offline") && s.includes("not yet implemented"))).toBe(true);
  });

  test("run --record warns not yet implemented", async () => {
    await cmdAgentGrid(["run", "--providers=claude", "--record=./out.ndjson", "--json"]);
    expect(stderrLines().some((s: string) => s.includes("--record") && s.includes("not yet implemented"))).toBe(true);
  });

  test("run --version warns not yet implemented", async () => {
    await cmdAgentGrid(["run", "--providers=claude", "--version=2.1.119", "--json"]);
    expect(stderrLines().some((s: string) => s.includes("--version") && s.includes("not yet implemented"))).toBe(true);
  });

  test("run --commit-outcome warns not yet implemented", async () => {
    await cmdAgentGrid(["run", "--providers=claude", "--commit-outcome", "--json"]);
    expect(stderrLines().some((s: string) => s.includes("--commit-outcome") && s.includes("not yet implemented"))).toBe(
      true,
    );
  });
});

// ── gateTest integration (from agent-grid package) ─────────────────

describe("gateTest integration", () => {
  test("gates codex out of worktree tests", () => {
    const codex = mustGetProvider("codex");
    const gridTest: GridTest = {
      name: "needs-worktree",
      requires: ["worktree"],
      run: async () => ({ status: "pass" }),
    };
    const result = gateTest(gridTest, codex);
    expect(result).not.toBeNull();
    expect(result?.status).toBe("n/a");
  });

  test("allows claude for worktree tests", () => {
    const claude = mustGetProvider("claude");
    const gridTest: GridTest = {
      name: "needs-worktree",
      requires: ["worktree"],
      run: async () => ({ status: "pass" }),
    };
    expect(gateTest(gridTest, claude)).toBeNull();
  });
});
