#!/usr/bin/env bun
/**
 * Query the centralized test failure database.
 *
 * Usage:
 *   bun scripts/test-failures.ts                    # show all failures
 *   bun scripts/test-failures.ts --top 10           # top 10 most frequent
 *   bun scripts/test-failures.ts --since 7d         # last 7 days
 *   bun scripts/test-failures.ts --file foo.spec    # specific file history
 *   bun scripts/test-failures.ts --json             # raw JSON output
 */

import { type TestFailureEntry, readFailures } from "./test-failure-log";

export function parseArgs(argv: string[]): {
  top: number | null;
  since: number | null;
  file: string | null;
  json: boolean;
} {
  const args = argv.slice(2);
  let top: number | null = null;
  let since: number | null = null;
  let file: string | null = null;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--top": {
        const val = args[++i];
        if (val === undefined) {
          throw new Error("--top requires a numeric argument");
        }
        const parsed = Number.parseInt(val, 10);
        if (Number.isNaN(parsed) || parsed <= 0) {
          throw new Error(`--top value must be a positive integer, got: ${val}`);
        }
        top = parsed;
        break;
      }
      case "--since": {
        const val = args[++i];
        if (val === undefined) {
          throw new Error("--since requires an argument (e.g. 7d, 24h, 30m)");
        }
        const match = val.match(/^(\d+)([dhm])$/);
        if (!match) {
          throw new Error(`Invalid --since value: ${val} (expected e.g. 7d, 24h, 30m)`);
        }
        const num = Number.parseInt(match[1], 10);
        const unit = match[2];
        const multipliers: Record<string, number> = { d: 86400000, h: 3600000, m: 60000 };
        since = Date.now() - num * multipliers[unit];
        break;
      }
      case "--file": {
        const val = args[++i];
        if (val === undefined) {
          throw new Error("--file requires an argument");
        }
        file = val;
        break;
      }
      case "--json":
        json = true;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: bun scripts/test-failures.ts [OPTIONS]

Options:
  --top N       Show top N most frequent failures
  --since Xd    Filter to last X days/hours/minutes (e.g. 7d, 24h, 30m)
  --file PAT    Filter to files matching pattern
  --json        Output raw JSON
  --help        Show this help`);
        process.exit(0);
    }
  }

  return { top, since, file, json };
}

export function formatOutput(entries: TestFailureEntry[], opts: { top: number | null; json: boolean }): string {
  if (entries.length === 0) {
    return "No test failures recorded.";
  }

  if (opts.json) {
    return JSON.stringify(entries, null, 2);
  }

  if (opts.top !== null) {
    // Aggregate by file+test and show most frequent
    const counts = new Map<string, { count: number; lastSeen: string; file: string; test: string }>();
    for (const e of entries) {
      const key = `${e.file}::${e.test}`;
      const existing = counts.get(key);
      if (existing) {
        existing.count++;
        if (e.timestamp > existing.lastSeen) existing.lastSeen = e.timestamp;
      } else {
        counts.set(key, { count: 1, lastSeen: e.timestamp, file: e.file, test: e.test });
      }
    }

    const sorted = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, opts.top);

    const lines: string[] = [];
    lines.push(`Top ${Math.min(opts.top, sorted.length)} most frequent test failures:\n`);
    lines.push("Count  Last seen             File                                    Test");
    lines.push("─────  ────────────────────  ──────────────────────────────────────  ────────────────────────────");
    for (const { count, lastSeen, file: f, test } of sorted) {
      const date = lastSeen.slice(0, 19).replace("T", " ");
      lines.push(`${String(count).padStart(5)}  ${date.padEnd(20)}  ${f.padEnd(38)}  ${test}`);
    }
    return lines.join("\n");
  }

  // Show recent failures
  const lines: string[] = [];
  lines.push(`${entries.length} test failure(s) recorded:\n`);
  lines.push("Timestamp             File                                    Test                          Retry?");
  lines.push("────────────────────  ──────────────────────────────────────  ────────────────────────────  ──────");
  for (const e of entries.slice(-50)) {
    const date = e.timestamp.slice(0, 19).replace("T", " ");
    const retry = e.retryPassed ? "yes" : "no";
    lines.push(`${date.padEnd(20)}  ${e.file.padEnd(38)}  ${e.test.slice(0, 28).padEnd(28)}  ${retry}`);
  }
  if (entries.length > 50) {
    lines.push(`\n... and ${entries.length - 50} more. Use --top or --since to filter.`);
  }
  return lines.join("\n");
}

function main(): void {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  const { top, since, file, json } = parsed;

  // Push filters to SQL
  const entries = readFailures(undefined, {
    ...(since !== null ? { since } : {}),
    ...(file !== null ? { file } : {}),
  });

  console.log(formatOutput(entries, { top, json }));
}

if (import.meta.main) {
  main();
}
