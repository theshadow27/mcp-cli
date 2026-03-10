#!/usr/bin/env bun
/**
 * Query the centralized test failure log.
 *
 * Usage:
 *   bun scripts/test-failures.ts                    # show all failures
 *   bun scripts/test-failures.ts --top 10           # top 10 most frequent
 *   bun scripts/test-failures.ts --since 7d         # last 7 days
 *   bun scripts/test-failures.ts --file foo.spec    # specific file history
 *   bun scripts/test-failures.ts --json             # raw JSON output
 */

import { type TestFailureEntry, readFailures } from "./test-failure-log";

function parseArgs(): { top: number | null; since: number | null; file: string | null; json: boolean } {
  const args = process.argv.slice(2);
  let top: number | null = null;
  let since: number | null = null;
  let file: string | null = null;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--top":
        top = Number.parseInt(args[++i], 10);
        break;
      case "--since": {
        const val = args[++i];
        const match = val.match(/^(\d+)([dhm])$/);
        if (!match) {
          console.error(`Invalid --since value: ${val} (expected e.g. 7d, 24h, 30m)`);
          process.exit(1);
        }
        const num = Number.parseInt(match[1], 10);
        const unit = match[2];
        const multipliers: Record<string, number> = { d: 86400000, h: 3600000, m: 60000 };
        since = Date.now() - num * multipliers[unit];
        break;
      }
      case "--file":
        file = args[++i];
        break;
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

function main(): void {
  const { top, since, file, json } = parseArgs();
  let entries = readFailures();

  if (entries.length === 0) {
    console.log("No test failures recorded.");
    return;
  }

  // Filter by time
  if (since !== null) {
    entries = entries.filter((e) => new Date(e.timestamp).getTime() >= since);
  }

  // Filter by file
  if (file !== null) {
    entries = entries.filter((e) => e.file.includes(file));
  }

  if (json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  if (top !== null) {
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

    const sorted = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, top);

    console.log(`Top ${Math.min(top, sorted.length)} most frequent test failures:\n`);
    console.log("Count  Last seen             File                                    Test");
    console.log("─────  ────────────────────  ──────────────────────────────────────  ────────────────────────────");
    for (const { count, lastSeen, file: f, test } of sorted) {
      const date = lastSeen.slice(0, 19).replace("T", " ");
      console.log(`${String(count).padStart(5)}  ${date.padEnd(20)}  ${f.padEnd(38)}  ${test}`);
    }
  } else {
    // Show recent failures
    console.log(`${entries.length} test failure(s) recorded:\n`);
    console.log("Timestamp             File                                    Test                          Retry?");
    console.log("────────────────────  ──────────────────────────────────────  ────────────────────────────  ──────");
    for (const e of entries.slice(-50)) {
      const date = e.timestamp.slice(0, 19).replace("T", " ");
      const retry = e.retryPassed ? "yes" : "no";
      console.log(`${date.padEnd(20)}  ${e.file.padEnd(38)}  ${e.test.slice(0, 28).padEnd(28)}  ${retry}`);
    }
    if (entries.length > 50) {
      console.log(`\n... and ${entries.length - 50} more. Use --top or --since to filter.`);
    }
  }
}

main();
