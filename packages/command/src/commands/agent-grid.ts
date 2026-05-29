/**
 * `mcx agent-grid run` — local runner for the agent capability grid.
 *
 * Runs the capability test suite against one or more providers and produces
 * a JSON capability report. Read-only by default; --commit-outcome writes
 * results back to versions.yaml.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type GridResult, type GridTest, gateTest } from "@mcp-cli/agent-grid";
import { type AgentProvider, getAllProviders, getProvider } from "@mcp-cli/core";
import { parseFlags } from "../flags";
import { formatHelp, getHelp, hasHelpFlag, registerHelp } from "../help";
import { c, printError } from "../output";

// ── Types ──────────────────────────────────────────────────────────

interface TestOutcome {
  test: string;
  result: GridResult;
}

interface ProviderReport {
  provider: string;
  version: string | null;
  outcomes: TestOutcome[];
  summary: { pass: number; fail: number; na: number };
}

interface GridRunReport {
  providers: ProviderReport[];
  elapsed_ms: number;
}

// ── Test discovery ─────────────────────────────────────────────────

function discoverTests(): GridTest[] {
  // Test implementations are added by later issues in the epic.
  // The skeleton returns an empty suite — the runner still exercises
  // the full flag-parse → gate → report pipeline.
  return [];
}

// ── Runner ─────────────────────────────────────────────────────────

async function runGridForProvider(
  provider: AgentProvider,
  tests: GridTest[],
  opts: { version: string | null; record: string | null; offline: boolean },
): Promise<ProviderReport> {
  const outcomes: TestOutcome[] = [];
  const cwd = mkdtempSync(resolve(tmpdir(), `agent-grid-${provider.name}-`));

  try {
    for (const test of tests) {
      const gateResult = gateTest(test, provider);
      if (gateResult) {
        outcomes.push({ test: test.name, result: gateResult });
        continue;
      }
      try {
        const result = await test.run({ provider, cwd });
        outcomes.push({ test: test.name, result });
      } catch (err) {
        outcomes.push({
          test: test.name,
          result: { status: "fail", error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  } finally {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  const summary = {
    pass: outcomes.filter((o) => o.result.status === "pass").length,
    fail: outcomes.filter((o) => o.result.status === "fail").length,
    na: outcomes.filter((o) => o.result.status === "n/a").length,
  };

  return { provider: provider.name, version: opts.version, outcomes, summary };
}

// ── Output formatting ──────────────────────────────────────────────

function formatReportText(report: GridRunReport): string {
  const lines: string[] = [];

  if (report.providers.length === 0) {
    lines.push("No providers selected.");
    return lines.join("\n");
  }

  for (const pr of report.providers) {
    const ver = pr.version ? `@${pr.version}` : "";
    lines.push(`${c.bold}${pr.provider}${ver}${c.reset}`);

    if (pr.outcomes.length === 0) {
      lines.push("  (no tests registered)");
    }
    for (const o of pr.outcomes) {
      const icon =
        o.result.status === "pass"
          ? `${c.green}pass${c.reset}`
          : o.result.status === "fail"
            ? `${c.red}fail${c.reset}`
            : `${c.dim}n/a${c.reset}`;
      let detail = "";
      if (o.result.status === "fail") detail = ` — ${o.result.error}`;
      else if (o.result.status === "n/a") detail = ` — ${o.result.reason}`;
      lines.push(`  ${icon}  ${o.test}${detail}`);
    }
    lines.push(`  ${c.dim}(${pr.summary.pass} pass, ${pr.summary.fail} fail, ${pr.summary.na} n/a)${c.reset}`);
    lines.push("");
  }

  lines.push(`${c.dim}elapsed: ${report.elapsed_ms}ms${c.reset}`);
  return lines.join("\n");
}

// ── Help ───────────────────────────────────────────────────────────

registerHelp("agent-grid", {
  name: "agent-grid",
  summary: "Agent capability grid — run tests, inspect results",
  usage: ["mcx agent-grid run [--providers=X,Y] [--version=V] [--offline] [--record=path] [--commit-outcome]"],
  options: [
    ["--providers <names>", "Comma-separated provider names (default: all enabled)"],
    ["--version <ver>", "Test a specific version (default: latest)"],
    ["--offline", "Install from LFS archive only; fail if not cached"],
    ["--record <path>", "Save recording to path (default: temp)"],
    ["--commit-outcome", "Write results back to versions.yaml"],
    ["--json", "Output raw JSON instead of formatted text"],
  ],
  examples: [
    "mcx agent-grid run --providers=codex",
    "mcx agent-grid run --providers=claude --version=2.1.119 --record=./out.ndjson",
    "mcx agent-grid run --json",
  ],
});

// ── Flag parsing ───────────────────────────────────────────────────

interface RunOptions {
  providers: string[];
  version: string | null;
  offline: boolean;
  record: string | null;
  commitOutcome: boolean;
  json: boolean;
}

function parseRunArgs(args: string[]): RunOptions {
  const { flags, errors, help } = parseFlags(args, {
    providers: { type: "string", alias: "p" },
    version: { type: "string" },
    offline: { type: "boolean" },
    record: { type: "string", alias: "r" },
    "commit-outcome": { type: "boolean" },
    json: { type: "boolean" },
  });

  if (help) {
    const h = formatHelp({
      name: "agent-grid run",
      summary: "Run capability tests against agent providers",
      usage: ["mcx agent-grid run [flags]"],
      options: [
        ["--providers, -p <names>", "Comma-separated provider names (default: all enabled)"],
        ["--version <ver>", "Test a specific version"],
        ["--offline", "Install from LFS archive only"],
        ["--record, -r <path>", "Save recording to path"],
        ["--commit-outcome", "Write results back to versions.yaml"],
        ["--json", "Output JSON"],
      ],
    });
    console.error(h);
    process.exit(0);
  }

  if (errors.length > 0) {
    for (const e of errors) printError(e);
    process.exit(1);
  }

  const rawProviders = typeof flags.providers === "string" ? flags.providers : "";
  const providerNames = rawProviders
    ? rawProviders
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  return {
    providers: providerNames,
    version: typeof flags.version === "string" ? flags.version : null,
    offline: flags.offline === true,
    record: typeof flags.record === "string" ? flags.record : null,
    commitOutcome: flags["commit-outcome"] === true,
    json: flags.json === true,
  };
}

// ── Resolve providers ──────────────────────────────────────────────

function resolveProviders(names: string[]): AgentProvider[] {
  if (names.length === 0) {
    return getAllProviders();
  }
  const resolved: AgentProvider[] = [];
  for (const name of names) {
    const p = getProvider(name);
    if (!p) {
      printError(`unknown provider: ${name}`);
      const available = getAllProviders().map((pr) => pr.name);
      console.error(`  available: ${available.join(", ")}`);
      process.exit(1);
    }
    resolved.push(p);
  }
  return resolved;
}

// ── Subcommand dispatch ────────────────────────────────────────────

async function agentGridRun(args: string[]): Promise<void> {
  const opts = parseRunArgs(args);
  const providers = resolveProviders(opts.providers);
  const tests = discoverTests();

  const start = performance.now();

  const providerReports: ProviderReport[] = [];
  for (const provider of providers) {
    const report = await runGridForProvider(provider, tests, {
      version: opts.version,
      record: opts.record,
      offline: opts.offline,
    });
    providerReports.push(report);
  }

  const elapsed = Math.round(performance.now() - start);
  const report: GridRunReport = { providers: providerReports, elapsed_ms: elapsed };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReportText(report));
  }

  if (opts.commitOutcome) {
    console.error(`${c.yellow}--commit-outcome: writing to versions.yaml is not yet implemented${c.reset}`);
  }

  const anyFail = providerReports.some((r) => r.summary.fail > 0);
  if (anyFail) process.exit(1);
}

// ── Main entry ─────────────────────────────────────────────────────

export async function cmdAgentGrid(args: string[]): Promise<void> {
  if (args.length === 0 || hasHelpFlag(args)) {
    const help = getHelp("agent-grid");
    if (help) console.error(formatHelp(help));
    return;
  }

  const sub = args[0];
  switch (sub) {
    case "run":
      await agentGridRun(args.slice(1));
      break;
    default:
      printError(`unknown subcommand: ${sub}`);
      console.error('Run "mcx agent-grid --help" for usage.');
      process.exit(1);
  }
}
