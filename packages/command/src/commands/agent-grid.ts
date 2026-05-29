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
import { type GridResult, type GridTest, gateTest, parseRecording, validateRecording } from "@mcp-cli/agent-grid";
import { type AgentProvider, getAllProviders, getProvider } from "@mcp-cli/core";
import { parseFlags } from "../flags";
import { formatHelp, getHelp, hasHelpFlag, registerHelp } from "../help";
import { c, printError } from "../output";

// ── Types ──────────────────────────────────────────────────────────

export interface TestOutcome {
  test: string;
  result: GridResult;
}

export interface ProviderReport {
  provider: string;
  version: string | null;
  outcomes: TestOutcome[];
  summary: { pass: number; fail: number; na: number };
}

export interface GridRunReport {
  providers: ProviderReport[];
  elapsed_ms: number;
}

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_TEST_TIMEOUT_MS = 30_000;
const EXCLUDED_DEFAULT_PROVIDERS = new Set(["mock"]);

// ── Test discovery ─────────────────────────────────────────────────

export function discoverTests(): GridTest[] {
  // Test implementations are added by later issues in the epic (#2538).
  return [];
}

// ── Runner ─────────────────────────────────────────────────────────

export async function runGridForProvider(
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
        const result = await Promise.race([
          test.run({ provider, cwd }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`test timed out after ${DEFAULT_TEST_TIMEOUT_MS}ms`)),
              DEFAULT_TEST_TIMEOUT_MS,
            ),
          ),
        ]);
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

export function formatReportText(report: GridRunReport): string {
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
  summary: "Agent capability grid — run tests, inspect results, replay recordings",
  usage: [
    "mcx agent-grid run [--providers=X,Y] [--version=V] [--offline] [--record=path] [--commit-outcome]",
    "mcx agent-grid replay <recording> [--json]",
  ],
  options: [
    ["--providers, -p <names>", "Comma-separated provider names (default: all enabled)"],
    ["--version <ver>", "Test a specific version (default: latest)"],
    ["--offline", "Install from LFS archive only; fail if not cached"],
    ["--record, -r <path>", "Save recording to path"],
    ["--commit-outcome", "Write results back to versions.yaml"],
    ["--json", "Output raw JSON instead of formatted text"],
  ],
  examples: [
    "mcx agent-grid run --providers=codex",
    "mcx agent-grid run --providers=claude --version=2.1.119 --record=./out.ndjson",
    "mcx agent-grid run --json",
    "mcx agent-grid replay ./session.ndjson",
  ],
});

registerHelp("agent-grid run", {
  name: "agent-grid run",
  summary: "Run capability tests against agent providers",
  usage: ["mcx agent-grid run [flags]"],
  options: [
    ["--providers, -p <names>", "Comma-separated provider names (default: all enabled)"],
    ["--version <ver>", "Test a specific version (default: latest)"],
    ["--offline", "Install from LFS archive only; fail if not cached"],
    ["--record, -r <path>", "Save recording to path"],
    ["--commit-outcome", "Write results back to versions.yaml"],
    ["--json", "Output raw JSON instead of formatted text"],
  ],
});

// ── Flag parsing ───────────────────────────────────────────────────

export interface RunOptions {
  providers: string[];
  version: string | null;
  offline: boolean;
  record: string | null;
  commitOutcome: boolean;
  json: boolean;
}

export function parseRunArgs(args: string[]): RunOptions | null {
  const { flags, errors, help } = parseFlags(args, {
    providers: { type: "string", alias: "p" },
    version: { type: "string" },
    offline: { type: "boolean" },
    record: { type: "string", alias: "r" },
    "commit-outcome": { type: "boolean" },
    json: { type: "boolean" },
  });

  if (help) {
    return null;
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

export function resolveProviders(names: string[]): AgentProvider[] {
  if (names.length === 0) {
    return getAllProviders().filter((p) => !EXCLUDED_DEFAULT_PROVIDERS.has(p.name));
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

// ── Stub flag warnings ─────────────────────────────────────────────

function warnStubFlags(opts: RunOptions): void {
  if (opts.offline) {
    console.error(`${c.yellow}--offline: not yet implemented; network access is not restricted${c.reset}`);
  }
  if (opts.record) {
    console.error(`${c.yellow}--record: not yet implemented; recording will not be saved${c.reset}`);
  }
  if (opts.version) {
    console.error(`${c.yellow}--version: not yet implemented; using current installed version${c.reset}`);
  }
  if (opts.commitOutcome) {
    console.error(`${c.yellow}--commit-outcome: not yet implemented; versions.yaml will not be updated${c.reset}`);
  }
}

// ── Subcommand dispatch ────────────────────────────────────────────

async function agentGridRun(args: string[]): Promise<void> {
  const opts = parseRunArgs(args);
  if (!opts) {
    const h = getHelp("agent-grid run");
    if (h) console.log(formatHelp(h));
    return;
  }

  warnStubFlags(opts);

  const providers = resolveProviders(opts.providers);
  const tests = discoverTests();

  if (tests.length === 0) {
    console.error(`${c.yellow}warning: no tests registered; suite is empty${c.reset}`);
  }

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

  const anyFail = providerReports.some((r) => r.summary.fail > 0);
  if (anyFail) process.exit(1);
}

// ── Replay ────────────────────────────────────────────────────────

registerHelp("agent-grid replay", {
  name: "agent-grid replay",
  summary: "Replay a recorded NDJSON exchange and validate protocol conformance",
  usage: ["mcx agent-grid replay <recording> [flags]"],
  options: [["--json", "Output raw JSON instead of formatted text"]],
  examples: ["mcx agent-grid replay ./session.ndjson", "mcx agent-grid replay ./session.ndjson --json"],
});

export interface ReplayOptions {
  file: string;
  json: boolean;
}

export function parseReplayArgs(args: string[]): ReplayOptions | null {
  const { flags, positionals, errors, help } = parseFlags(args, {
    json: { type: "boolean" },
  });

  if (help) return null;

  if (errors.length > 0) {
    for (const e of errors) printError(e);
    process.exit(1);
  }

  if (positionals.length === 0) {
    printError("missing required argument: <recording>");
    console.error('Run "mcx agent-grid replay --help" for usage.');
    process.exit(1);
  }

  return {
    file: positionals[0],
    json: flags.json === true,
  };
}

export function formatReplayText(report: ReturnType<typeof validateRecording>): string {
  const lines: string[] = [];

  lines.push(`${c.bold}replay${c.reset}: ${report.file}`);
  lines.push(`${c.dim}entries: ${report.entries}${c.reset}`);
  lines.push("");

  if (report.pass) {
    lines.push(`${c.green}pass${c.reset} — recording conforms to the agent protocol spec`);
  } else {
    lines.push(`${c.red}fail${c.reset} — ${report.violations.length} violation(s):\n`);
    for (const v of report.violations) {
      lines.push(`  ${c.red}line ${v.line}${c.reset}  [${v.rule}]  ${v.message}`);
    }
  }

  return lines.join("\n");
}

async function agentGridReplay(args: string[]): Promise<void> {
  const opts = parseReplayArgs(args);
  if (!opts) {
    const h = getHelp("agent-grid replay");
    if (h) console.log(formatHelp(h));
    return;
  }

  let entries: ReturnType<typeof parseRecording>;
  try {
    entries = parseRecording(opts.file);
  } catch (err) {
    printError(`failed to parse recording: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const report = validateRecording(entries, opts.file);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReplayText(report));
  }

  if (!report.pass) process.exit(1);
}

// ── Main entry ─────────────────────────────────────────────────────

export async function cmdAgentGrid(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === "run") {
    await agentGridRun(args.slice(1));
    return;
  }

  if (sub === "replay") {
    await agentGridReplay(args.slice(1));
    return;
  }

  if (!sub || hasHelpFlag(args)) {
    const help = formatHelp({
      name: "agent-grid",
      summary: "Agent capability grid — run tests, inspect results",
      usage: ["mcx agent-grid <subcommand> [flags]"],
      options: [
        ["run", "Run capability tests against agent providers"],
        ["replay", "Replay a recorded NDJSON exchange and validate protocol conformance"],
      ],
    });
    console.log(help);
    return;
  }

  printError(`unknown subcommand: ${sub}`);
  console.error('Run "mcx agent-grid --help" for usage.');
  process.exit(1);
}
