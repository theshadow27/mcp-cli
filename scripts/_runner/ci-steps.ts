/**
 * CI-flavoured step factories with #1004 / #1419 crash tolerance.
 *
 * Bun v1.3.x exhibits two known crash signatures that masquerade as test
 * failures even when the test suite passed cleanly:
 *
 *   - #1004 — non-deterministic SIGILL (exit 132) or post-cleanup exit 1.
 *     Fires AFTER all tests complete, so the `bun test` summary still
 *     reports "0 fail". CI must not treat that as a real failure.
 *   - #1419 — coverage script panic during teardown. "PASS: All coverage
 *     thresholds met" / "0 fail" in the captured output is authoritative;
 *     the exit code is not.
 *
 * These factories own the retry-and-classify logic so the bash version of
 * it in `.github/workflows/ci.yml` can go away. The pre-push hook runs
 * the same code path locally as CI does on the remote — one definition of
 * done (#2345).
 *
 * On-disk artefacts: each invocation writes captured combined output to
 * `<TMP>/<logName>.txt` (and `<logName>_retry.txt` on retry) so the CI
 * workflow's `Upload test logs` / `Upload coverage logs` steps can pick
 * up the same paths they did before. Local runs leave the files in /tmp
 * — harmless.
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Glob } from "bun";

import { buildImportGraph } from "../rules/_engine/import-graph";
import { filterByClosureCache, readFileCache, storeFileVerdicts, writeFileCache } from "./file-cache";
import type { Logger, ScriptFunction, StepResult } from "./types";
import { computeVerdictKey, lookupVerdict, storeVerdict } from "./verdict-cache";

// Artefact directory matches the path the CI workflow's `Upload test/coverage
// logs` steps glob for (`/tmp/test_*.txt`, `/tmp/coverage_*.txt`). `/tmp`
// works on both the Linux runner and macOS dev machines; we don't use
// `os.tmpdir()` because on macOS that resolves to /var/folders/... and
// would silently break the CI artefact upload glob if this ever ran there.
const LOG_DIR = "/tmp";

interface RunOutcome {
  code: number;
  output: string;
  /**
   * Fault count from the junit XML written by --reporter junit (`failures` +
   * `errors`), or null if unavailable. Bun's "unhandled error between tests"
   * (a module-scope throw between test registrations) increments `errors`, not
   * `failures` — both must be counted or such a run is misclassified as clean
   * (#2669).
   */
  junitFailures: number | null;
}

/**
 * Parse the fault count from a bun junit XML report: the `failures` attribute
 * PLUS the `errors` attribute. Returns null when the file is absent or has
 * neither attribute. An "unhandled error between tests" reports failures="0"
 * errors="1", so summing is what makes the gate fail on it (#2669).
 */
function parseJunitFailures(xmlPath: string): number | null {
  try {
    const xml = readFileSync(xmlPath, "utf8");
    const fm = xml.match(/failures="(\d+)"/);
    const em = xml.match(/errors="(\d+)"/);
    if (!fm && !em) return null;
    const failures = fm ? Number.parseInt(fm[1], 10) : 0;
    const errors = em ? Number.parseInt(em[1], 10) : 0;
    return failures + errors;
  } catch {
    return null;
  }
}

/**
 * Parse the `{ failures: N }` JSON summary written by check-coverage.ts via --junit-outfile.
 * Returns null when the file is absent or unparseable.
 */
function parseCoverageFailures(jsonPath: string): number | null {
  try {
    const raw = readFileSync(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as { failures?: unknown };
    return typeof parsed.failures === "number" ? parsed.failures : null;
  } catch {
    return null;
  }
}

/** Generate a unique path under LOG_DIR for a junit XML file. */
function junitTmpPath(stem: string): string {
  return join(LOG_DIR, `junit_${stem}_${Date.now()}_${Math.random().toString(36).slice(2)}.xml`);
}

/**
 * True when the run produced zero test failures, using a two-signal hybrid:
 *   1. JUnit XML (primary): authoritative when the file exists and is parseable.
 *   2. ZERO_FAIL_RE on stdout (fallback): bun crashes during post-test teardown
 *      BEFORE flushing the junit file (the #1004 scenario). Stdout is written
 *      incrementally and the " 0 fail" summary line survives a teardown crash
 *      even when the sidecar file does not (#2401).
 */
function hasZeroJunitFailures(outcome: RunOutcome): boolean {
  if (outcome.junitFailures === 0) return true;
  if (outcome.junitFailures === null) return ZERO_FAIL_RE.test(outcome.output) && !hasUnhandledError(outcome.output);
  return false;
}

// Bun emits "# Unhandled error between tests" plus a nonzero "N errors" summary
// line when a module-scope throw aborts test registration. Neither increments
// the junit `failures` attribute, and a teardown crash that also drops the
// junit sidecar (#1004) would leave only the stdout " 0 fail" line — which the
// prose fallback would otherwise read as clean. Detect the error markers so a
// run with an unhandled between-tests error is never promoted to a pass (#2669).
const UNHANDLED_ERROR_RE = /Unhandled error between tests/;
const NONZERO_ERRORS_RE = /^\s*([1-9]\d*) errors?\b/m;

function hasUnhandledError(output: string): boolean {
  return UNHANDLED_ERROR_RE.test(output) || NONZERO_ERRORS_RE.test(output);
}

async function runBun(
  args: string[],
  logger: Logger,
  env: Record<string, string | undefined> = process.env,
  junitPath?: string,
  cwd?: string,
): Promise<RunOutcome> {
  // spawn() rejects undefined env values — drop them so explicit `unset`
  // semantics aren't required upstream. Matches runShell() in runner.ts.
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) cleanEnv[k] = v;
  // Add junit reporter when a path is provided and this is a `bun test` invocation
  // so classifiers can key off failures="N" rather than prose summary text (#2401).
  const fullArgs =
    junitPath && args[0] === "test" ? [...args, "--reporter", "junit", `--reporter-outfile=${junitPath}`] : args;
  const buf: string[] = [];
  const child = spawn("bun", fullArgs, { env: cleanEnv, stdio: ["ignore", "pipe", "pipe"], ...(cwd ? { cwd } : {}) });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    buf.push(d);
    logger.info(d.trimEnd());
  });
  child.stderr.on("data", (d: string) => {
    buf.push(d);
    logger.error(d.trimEnd());
  });
  const code = await new Promise<number>((resolve) => {
    child.on("close", (c: number | null, signal: string | null) => {
      if (signal) logger.warn(`child killed by ${signal} (code=${c})`);
      resolve(c ?? -1);
    });
    child.on("error", (err: Error) => {
      logger.error(`spawn error: ${err.message} (code=${(err as NodeJS.ErrnoException).code})`);
      resolve(-1);
    });
  });
  const junitFailures = junitPath ? parseJunitFailures(junitPath) : null;
  return { code, output: buf.join(""), junitFailures };
}

function persistLog(logName: string, output: string): void {
  try {
    writeFileSync(join(LOG_DIR, `${logName}.txt`), output);
  } catch {
    /* best-effort — artefact preservation is non-essential */
  }
}

// Anchors the Bun test-summary line. Used as a durable fallback when the junit
// reporter file was not written — e.g. bun crashes during post-test teardown
// BEFORE flushing the file (the #1004 scenario). Stdout is written incrementally
// and survives a teardown crash even when the sidecar file does not.
const ZERO_FAIL_RE = /^ 0 fail$/m;
// Anchored to line start: check-coverage.ts prints this at column 0. Inner test
// runs echo `(pass) … > … `PASS: All coverage thresholds met` …` test NAMES to
// stdout (the literal at ci-steps.spec.ts), where the phrase sits mid-line behind
// a backtick — an unanchored match there silently classified a genuine ratchet
// FAILURE as a #1419 crash-after-pass and let CI swallow it (#2744).
const COVERAGE_PASS_RE = /^PASS: All coverage thresholds met/m;
const FAIL_LINE_RE = /^FAIL:/m;

interface TestOpts {
  /** `bun test` positional arguments — directories and/or spec files. */
  paths: string[];
  /** Stem used for `<TMP>/<logName>.txt` artefact preservation. */
  logName: string;
  /** Whether to retry once on exit 132 (SIGILL). Daemon tests historically need this. */
  retryOn132?: boolean;
}

export function bunTestWithCrashTolerance(opts: TestOpts): ScriptFunction {
  return async ({ logger, env }) => {
    const args = ["test", "--no-orphans", ...opts.paths];

    const first = await runBun(args, logger, env, junitTmpPath(opts.logName));
    persistLog(opts.logName, first.output);
    if (first.code === 0) return { success: true };
    if (hasZeroJunitFailures(first)) {
      logger.warn(`bun crash (exit ${first.code}) after all tests passed — treating as pass (#1004)`);
      return { success: true };
    }
    if (!opts.retryOn132 || first.code !== 132) {
      return { success: false, error: `exit ${first.code}` };
    }

    logger.warn("bun segfault (exit 132) — retrying once (#1004)");
    const second = await runBun(args, logger, env, junitTmpPath(`${opts.logName}_retry`));
    persistLog(`${opts.logName}_retry`, second.output);
    if (second.code === 0) return { success: true };
    if (hasZeroJunitFailures(second)) {
      logger.warn(`bun crash (exit ${second.code}) on retry after all tests passed — treating as pass (#1004)`);
      return { success: true };
    }
    if (second.code === 132) {
      logger.warn("bun segfault on retry too — treating as pass (known upstream bug, #1004)");
      return { success: true };
    }
    return { success: false, error: `exit ${second.code}` };
  };
}

interface PhasesTestOpts {
  /** Stem used for `<TMP>/<logName>.txt` artefact preservation. */
  logName: string;
  /** Absolute path to the `.claude/phases` directory. */
  phasesDir: string;
}

/**
 * Run `bun test --no-orphans` from within `.claude/phases/` so the files
 * are discovered relative to that CWD — bypassing the root bunfig.toml
 * `pathIgnorePatterns = [".claude/**"]` exclusion that silences them when
 * run from the repo root (#2648). Carries the same #1004 crash-after-pass
 * tolerance as `bunTestWithCrashTolerance`.
 */
export function phasesTestWithCrashTolerance(opts: PhasesTestOpts): ScriptFunction {
  return async ({ logger, env }) => {
    const args = ["test", "--no-orphans"];
    const first = await runBun(args, logger, env, junitTmpPath(opts.logName), opts.phasesDir);
    persistLog(opts.logName, first.output);
    if (first.code === 0) return { success: true };
    if (hasZeroJunitFailures(first)) {
      logger.warn(`bun crash (exit ${first.code}) after phase tests passed — treating as pass (#1004)`);
      return { success: true };
    }
    return { success: false, error: `exit ${first.code}` };
  };
}

interface CoverageOpts {
  /** Stem used for `<TMP>/<logName>.txt` artefact preservation. */
  logName: string;
}

export function coverageWithCrashTolerance(opts: CoverageOpts): ScriptFunction {
  return async ({ logger, env }) => {
    const summaryPath = join(LOG_DIR, `coverage_summary_${opts.logName}_${Date.now()}.json`);
    const args = ["scripts/check-coverage.ts", "--ci", `--junit-outfile=${summaryPath}`];

    const first = await runBun(args, logger, env);
    persistLog(opts.logName, first.output);
    const firstVerdict = classifyCoverage({ ...first, junitFailures: parseCoverageFailures(summaryPath) }, logger);
    if (firstVerdict.success) return firstVerdict;
    if (first.code !== 132 && first.code !== 139) {
      return { success: false, error: `exit ${first.code}` };
    }

    logger.warn(`bun panic (exit ${first.code}) — retrying once`);
    const retrySummaryPath = join(LOG_DIR, `coverage_summary_${opts.logName}_retry_${Date.now()}.json`);
    const second = await runBun(
      ["scripts/check-coverage.ts", "--ci", `--junit-outfile=${retrySummaryPath}`],
      logger,
      env,
    );
    persistLog(`${opts.logName}_retry`, second.output);
    const secondVerdict = classifyCoverage(
      { ...second, junitFailures: parseCoverageFailures(retrySummaryPath) },
      logger,
    );
    if (secondVerdict.success) return secondVerdict;
    return { success: false, error: `exit ${second.code}` };
  };
}

function classifyCoverage({ code, output, junitFailures }: RunOutcome, logger: Logger): StepResult {
  if (code === 0) return { success: true };
  // A run that printed its own `FAIL:` line at column 0 did NOT pass, regardless
  // of any `PASS:` text elsewhere in the output — the #1419 crash-after-pass
  // tolerance only applies to a clean run that crashed in teardown (#2744).
  if (COVERAGE_PASS_RE.test(output) && !FAIL_LINE_RE.test(output)) {
    logger.warn(`bun crash (exit ${code}) after coverage check passed — treating as pass (#1419)`);
    return { success: true };
  }
  // Primary: junit summary present and zero failures.
  // Fallback: check-coverage.ts crashes before writing its summary file — the
  // inner bun's " 0 fail" line still reaches our stdout (#2401 hybrid).
  const cleanTests = junitFailures === 0 || (junitFailures === null && ZERO_FAIL_RE.test(output));
  if (cleanTests && !FAIL_LINE_RE.test(output) && !hasUnhandledError(output)) {
    logger.warn(`bun crash (exit ${code}) after all coverage tests passed — treating as pass (#1419)`);
    return { success: true };
  }
  return { success: false, error: `exit ${code}` };
}

interface ChangedTestsOpts {
  /** Stem used for `<TMP>/<logName>.txt` artefact preservation. */
  logName: string;
  /**
   * Override for base-ref resolution. Defaults to the git merge-base resolver.
   * Injected in tests so they don't depend on the repo's git state (DI per
   * CLAUDE.md — `mock.module` pollutes Bun's global registry across files).
   */
  resolveBase?: () => string;
  /** Override repo root for verdict cache location. DI for tests. */
  repoRoot?: string;
  /** Override verdict-key computation. DI for tests. */
  computeKey?: (resolveBase: () => string, cwd?: string) => string | null;
  /** Override spec-file discovery. DI for tests. */
  findSpecFiles?: (repoRoot: string) => string[];
  /** Override import-graph builder. DI for tests. */
  buildGraph?: (files: string[]) => ReturnType<typeof buildImportGraph>;
}

/**
 * Synchronously find all spec files under the standard scan roots.
 * Uses Bun.Glob for efficient scanning.
 */
export function findAllSpecFiles(repoRoot: string): string[] {
  const roots = ["packages", "scripts", "test"];
  const results: string[] = [];
  for (const root of roots) {
    const cwd = join(repoRoot, root);
    const glob = new Glob("**/*.spec.{ts,tsx}");
    for (const rel of glob.scanSync({ cwd, absolute: false })) {
      if (rel.includes("node_modules")) continue;
      results.push(join(cwd, rel));
    }
  }
  return results;
}

/**
 * Build closure hashes for test files and identify which can be skipped
 * because their closure hash matches a previous green run (#2408).
 *
 * Returns null if the graph build fails (fall back to --changed).
 */
function tryClosureCacheFilter(
  specFiles: string[],
  repoRoot: string,
  graph: ReturnType<typeof buildImportGraph>,
  logger: Logger,
): { toRun: string[]; skipped: string[]; hashes: Map<string, string> } | null {
  try {
    return filterByClosureCache({ testFiles: specFiles, repoRoot, graph });
  } catch (err) {
    logger.warn(`closure cache filter failed, falling back to --changed: ${err}`);
    return null;
  }
}

function recordClosureVerdicts(
  specFiles: string[],
  hashes: Map<string, string>,
  passed: boolean,
  repoRoot: string,
): void {
  try {
    const cache = readFileCache(repoRoot);
    const verdicts = specFiles.map((f) => ({
      relPath: relative(repoRoot, f),
      closureHash: hashes.get(f) ?? "",
      passed,
    }));
    storeFileVerdicts(cache, verdicts);
    writeFileCache(repoRoot, cache);
  } catch {
    // Best-effort — cache write failure must not fail the gate.
  }
}

/**
 * Diff-aware test step for the local `--pre-push` gate. Runs only the test
 * files Bun's module graph says are affected by the diff (`bun test --changed`),
 * not the whole suite — the local gate covers the 99% blast radius in seconds;
 * the exhaustive suite + coverage ratchet stay in CI (`--ci`). See #2393.
 *
 * When the per-file closure cache (#2408) has entries, test files whose
 * closure hash (content of the file + all transitive imports) is unchanged
 * since their last green run are skipped entirely — even if `--changed`
 * would select them. This narrows the run further for the 38.7% of PRs
 * that touch a single leaf package.
 *
 * The safe subset runs `--parallel` (a quiet-machine sweep showed 0 flakes
 * across 22k executions); `packages/control` runs sequentially in a second
 * pass because of the yoga-layout TDZ crash under `--parallel` (#2362). Both
 * carry the #1004 crash-after-pass tolerance — a non-zero exit AFTER a clean
 * `0 fail` summary is a known post-test Bun crash, not a real failure. Note:
 * unlike `bunTestWithCrashTolerance`, this step does NOT retry on SIGILL (exit
 * 132) before the summary is printed — only post-summary crashes are tolerated.
 */
export function changedTestsStep(opts: ChangedTestsOpts): ScriptFunction {
  const resolveBase = opts.resolveBase ?? defaultResolveBase;
  const repoRoot = opts.repoRoot ?? resolve(fileURLToPath(import.meta.url), "../../..");
  const getKey = opts.computeKey ?? computeVerdictKey;
  const getSpecFiles = opts.findSpecFiles ?? findAllSpecFiles;
  const getGraph = opts.buildGraph ?? buildImportGraph;
  return async ({ logger, env }) => {
    const base = resolveBase();

    // Verdict cache: skip tests when the worktree state is unchanged (#2396).
    const key = getKey(() => base, repoRoot);
    if (key) {
      const cached = lookupVerdict(repoRoot, key);
      if (cached === true) {
        logger.info("verdict cache hit — worktree state unchanged since last green run, skipping tests (#2396)");
        return { success: true };
      }
    }

    // Per-file closure cache: identify test files whose transitive import
    // closure is unchanged since their last green run (#2408). These files
    // are passed as --path-ignore-patterns to bun test --changed, narrowing
    // the run within the diff-selected set.
    // Wrapped in try-catch because the graph build requires real source files
    // on disk — in test environments with fake bun/temp dirs this gracefully
    // falls through to plain --changed.
    let cacheResult: ReturnType<typeof tryClosureCacheFilter> = null;
    try {
      const t0 = performance.now();
      const specFiles = getSpecFiles(repoRoot);
      const graph = getGraph(specFiles);
      cacheResult = tryClosureCacheFilter(specFiles, repoRoot, graph, logger);
      const graphMs = (performance.now() - t0).toFixed(0);

      if (cacheResult && cacheResult.skipped.length > 0) {
        logger.info(
          `closure cache (${graphMs}ms): ${cacheResult.skipped.length} files unchanged, ${cacheResult.toRun.length} need re-run (#2408)`,
        );
      } else {
        logger.debug(`closure cache built in ${graphMs}ms, no files skipped`);
      }
    } catch (err) {
      logger.debug(`closure cache unavailable, falling back to --changed: ${err}`);
    }

    // Build --path-ignore-patterns for closure-cached skipped files (#2408).
    const skipPatterns: string[] = [];
    if (cacheResult && cacheResult.skipped.length > 0) {
      for (const abs of cacheResult.skipped) {
        skipPatterns.push(`--path-ignore-patterns=${relative(repoRoot, abs)}`);
      }
    }

    logger.info(`diff-aware: running tests affected by changes since ${base} (bun test --changed)`);

    // Safe subset, parallel. control excluded (yoga-layout TDZ under --parallel, #2362).
    // --pass-with-no-tests: a diff that touches no test-reachable code is a pass, not an error.
    const main = await runBun(
      [
        "test",
        "--no-orphans",
        `--changed=${base}`,
        "--parallel",
        "--path-ignore-patterns=packages/control/**",
        ...skipPatterns,
        "--pass-with-no-tests",
      ],
      logger,
      env,
      junitTmpPath(opts.logName),
    );
    persistLog(opts.logName, main.output);
    const mainVerdict = classifyChangedTest(main, logger);
    if (!mainVerdict.success) {
      if (key) storeVerdict(repoRoot, key, false);
      if (cacheResult) recordClosureVerdicts(cacheResult.toRun, cacheResult.hashes, false, repoRoot);
      return mainVerdict;
    }

    // control specs (sequential — yoga TDZ). Fast no-op when none changed.
    const controlSkipPatterns = skipPatterns.filter((p) => p.startsWith("--path-ignore-patterns=packages/control/"));
    const control = await runBun(
      ["test", "--no-orphans", `--changed=${base}`, "packages/control", ...controlSkipPatterns, "--pass-with-no-tests"],
      logger,
      env,
      junitTmpPath(`${opts.logName}_control`),
    );
    persistLog(`${opts.logName}_control`, control.output);
    const controlVerdict = classifyChangedTest(control, logger);
    if (key) storeVerdict(repoRoot, key, controlVerdict.success);

    // Record per-file verdicts only for files that actually ran (#2408).
    // Skipped files keep their existing cached green — re-stamping them
    // would create a circular guarantee (skipped → green → skipped).
    if (cacheResult) {
      recordClosureVerdicts(cacheResult.toRun, cacheResult.hashes, controlVerdict.success, repoRoot);
    }

    return controlVerdict;
  };
}

// Resolve the ref to diff against. `origin/main` is the primary candidate —
// it's the branch you're proposing to merge into and stable regardless of
// whether your local branch has a tracking ref. `@{upstream}` is tried next
// so that incremental pushes on a feature branch (where `@{upstream}` already
// has your earlier commits) scope only to what's new. Falls through to the
// local `main` and finally `HEAD~1`. Each candidate is validated by asking git
// for a real merge-base — a missing or unreachable ref simply moves to the next.
function defaultResolveBase(): string {
  for (const ref of ["origin/main", "@{upstream}", "main"]) {
    const r = spawnSync("git", ["merge-base", ref, "HEAD"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return "HEAD~1";
}

function classifyChangedTest(outcome: RunOutcome, logger: Logger): StepResult {
  if (outcome.code === 0) return { success: true };
  if (hasZeroJunitFailures(outcome)) {
    logger.warn(`bun crash (exit ${outcome.code}) after all changed tests passed — treating as pass (#1004)`);
    return { success: true };
  }
  return { success: false, error: `exit ${outcome.code}` };
}
