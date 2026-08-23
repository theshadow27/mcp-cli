/**
 * Guard-reachability harness engine (#3212).
 *
 * Mechanizes the manual review step described in `docs/domains.md` /
 * `mail-domain.spec.ts` (PR #3200): delete a guard, run ONLY the specs that
 * exercise a concrete/real dependency, and check that something goes red.
 * If nothing does, the guard is unreachable — dead code, or covered only by
 * a fake that doesn't reflect what the real dependency can actually produce.
 *
 * This is deliberately NOT a `doing-it-wrong` rule: rules check code SHAPE
 * statically (regex/AST over source text); this checks whether a guard is
 * REACHABLE at runtime, which requires actually mutating the file on disk
 * and running real tests against it. Different question, different
 * mechanism — see `scripts/guards/README.md`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { spawnCaptureSync } from "@mcp-cli/core/subprocess";

import type { GuardEntry, GuardMutation } from "./manifest";

/**
 * Thrown when a guard's mutation regex does not match its file's current
 * source. A stale mutation would otherwise silently mutate nothing, run the
 * concrete specs unchanged, and report the guard as DEAD — a false alarm
 * that looks exactly like a real one. Fail loud instead (mirrors
 * `MissingAnchorError` in the doing-it-wrong rule engine).
 */
export class MutationNotFoundError extends Error {
  constructor(
    public readonly guardId: string,
    public readonly file: string,
  ) {
    super(
      `guard '${guardId}': mutation pattern not found in ${file}. The guard's source moved or was refactored — update the mutation regex in scripts/guards/manifest.ts. Do not treat a "DEAD" result caused by this as a real dead-guard finding.`,
    );
    this.name = "MutationNotFoundError";
  }
}

/** Apply `entry.mutation` to `content`. Pure — does not touch disk. */
export function applyMutation(entry: GuardEntry, content: string): string {
  const { find, replace }: GuardMutation = entry.mutation;
  if (find.flags.includes("g")) {
    throw new Error(
      `guard '${entry.id}': mutation regex must not use the 'g' flag — each guard mutates exactly one site`,
    );
  }
  if (!find.test(content)) {
    throw new MutationNotFoundError(entry.id, entry.file);
  }
  return content.replace(find, replace);
}

function parseSummary(text: string): { pass: number; fail: number } {
  const passMatch = /^\s*(\d+)\s+pass\b/m.exec(text);
  const failMatch = /^\s*(\d+)\s+fail\b/m.exec(text);
  return {
    pass: passMatch ? Number.parseInt(passMatch[1] ?? "0", 10) : 0,
    fail: failMatch ? Number.parseInt(failMatch[1] ?? "0", 10) : 0,
  };
}

export type GuardStatus =
  /** Mutating the guard broke at least one concrete spec — the guard is load-bearing. */
  | "reachable"
  /** All concrete specs still passed after the mutation — the guard is unreachable from them. */
  | "dead"
  /** The spec run itself didn't complete (crash, timeout, no specs executed) — not a verdict either way. */
  | "error";

export interface GuardOutcome {
  entry: GuardEntry;
  status: GuardStatus;
  pass: number;
  fail: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface SpecRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface RunGuardOptions {
  /** Repo root that `entry.file` and `entry.concreteSpecs` are relative to. */
  repoRoot: string;
  /** Override for the spec runner. Defaults to `bun test <concreteSpecs>`. Test injection point. */
  runSpecs?: (repoRoot: string, specs: string[]) => SpecRunResult;
}

const SPEC_RUN_TIMEOUT_MS = 120_000;

function defaultRunSpecs(repoRoot: string, specs: string[]): SpecRunResult {
  // Absolute paths: a relative arg without a leading "./" is read by `bun
  // test` as a name FILTER, not a path — a spec file that doesn't happen to
  // match bun's default test-file naming convention (*.spec.*/*.test.*,
  // which `concreteSpecs` deliberately need not) would then match zero
  // files and silently run nothing rather than erroring.
  const absoluteSpecs = specs.map((s) => resolve(repoRoot, s));
  const r = spawnCaptureSync("bun", ["test", "--no-orphans", ...absoluteSpecs], {
    cwd: repoRoot,
    timeoutMs: SPEC_RUN_TIMEOUT_MS,
  });
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Mutate `entry.file` per its `mutation`, run ONLY `entry.concreteSpecs`
 * against the mutated file, then restore the original content — even if the
 * spec run throws. Sequential by design: two entries that mutate the same
 * file must not run concurrently (the manifest is evaluated one guard at a
 * time by `run-guards.ts`).
 */
export function evaluateGuard(entry: GuardEntry, opts: RunGuardOptions): GuardOutcome {
  const filePath = resolve(opts.repoRoot, entry.file);
  const original = readFileSync(filePath, "utf8");
  const mutated = applyMutation(entry, original);
  const runSpecs = opts.runSpecs ?? defaultRunSpecs;

  try {
    writeFileSync(filePath, mutated);
    const { exitCode, stdout, stderr } = runSpecs(opts.repoRoot, entry.concreteSpecs);
    const { pass, fail } = parseSummary(`${stdout}\n${stderr}`);
    const ranNothing = pass === 0 && fail === 0;
    const status: GuardStatus = exitCode === null || ranNothing ? "error" : fail > 0 ? "reachable" : "dead";
    return { entry, status, pass, fail, exitCode, stdout, stderr };
  } finally {
    writeFileSync(filePath, original);
  }
}
