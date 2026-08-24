#!/usr/bin/env bun
/**
 * `bun run guards` — the guard-reachability harness entry point (#3212).
 *
 *   bun run guards            # evaluate every registered guard
 *   bun run guards --id X     # evaluate one guard by id
 *   bun run guards --list     # list registered guard ids and exit
 *
 * Deliberately NOT wired into `bun run am-i-done`: each guard is a full
 * `bun test` invocation against its concrete specs, so the cost scales with
 * the manifest. See scripts/guards/README.md for the "why a separate
 * command" rationale (#3138, #2690 gate-contention history).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type GuardOutcome, type GuardStatus, evaluateGuard } from "./harness";
import { type GuardEntry, guards } from "./manifest";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

const STATUS_LABEL: Record<GuardStatus, string> = {
  reachable: "REACHABLE",
  dead: "*** DEAD ***",
  error: "*** ERROR ***",
};

function printOutcome(outcome: GuardOutcome): void {
  const label = STATUS_LABEL[outcome.status];
  console.log(
    `${pad(label, 14)} ${pad(outcome.entry.label, 50)} ${String(outcome.pass).padStart(4)} pass  ${String(outcome.fail).padStart(4)} fail`,
  );
  if (outcome.status === "error") {
    console.error(`  spec run did not produce a verdict (exitCode=${outcome.exitCode}). stderr:`);
    console.error(
      outcome.stderr
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n"),
    );
  }
  if (outcome.status === "dead") {
    console.error(
      `  guard '${outcome.entry.id}' in ${outcome.entry.file} survived its own deletion — either the guard ` +
        `is dead code, or ${outcome.entry.concreteSpecs.join(", ")} don't actually exercise it.`,
    );
  }
}

/**
 * Evaluate one guard, guaranteeing the file it mutates is restored even if
 * the process is interrupted mid-run (SIGINT/SIGTERM) — mirrors the EXIT
 * trap in the ad-hoc bash prototype this harness replaces (#3212).
 */
function evaluateWithSignalSafety(entry: GuardEntry): GuardOutcome {
  const filePath = resolve(REPO_ROOT, entry.file);
  const original = readFileSync(filePath, "utf8");

  const restore = (): void => {
    writeFileSync(filePath, original);
  };
  const onSignal = (): void => {
    restore();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return evaluateGuard(entry, { repoRoot: REPO_ROOT });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--list")) {
    for (const g of guards) console.log(`${g.id}\t${g.label}`);
    return;
  }

  const idIdx = argv.indexOf("--id");
  const onlyId = idIdx >= 0 ? argv[idIdx + 1] : undefined;
  const selected = onlyId ? guards.filter((g) => g.id === onlyId) : guards;

  if (onlyId && selected.length === 0) {
    console.error(`guard '${onlyId}' not registered. known: ${guards.map((g) => g.id).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  if (selected.length === 0) {
    console.log("no guards registered in scripts/guards/manifest.ts — nothing to check.");
    return;
  }

  let deadCount = 0;
  let errorCount = 0;
  // Sequential: two entries mutating the same file must never overlap.
  for (const entry of selected) {
    const outcome = evaluateWithSignalSafety(entry);
    printOutcome(outcome);
    if (outcome.status === "dead") deadCount++;
    if (outcome.status === "error") errorCount++;
  }

  const reachableCount = selected.length - deadCount - errorCount;
  console.log(
    `\nchecked ${selected.length} guard${selected.length === 1 ? "" : "s"}: ` +
      `${reachableCount} reachable, ${deadCount} dead, ${errorCount} error`,
  );
  process.exitCode = deadCount > 0 || errorCount > 0 ? 1 : 0;
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
