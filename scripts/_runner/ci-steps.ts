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
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
}

async function runBun(
  args: string[],
  logger: Logger,
  env: Record<string, string | undefined> = process.env,
): Promise<RunOutcome> {
  // spawn() rejects undefined env values — drop them so explicit `unset`
  // semantics aren't required upstream. Matches runShell() in runner.ts.
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) cleanEnv[k] = v;
  const buf: string[] = [];
  const child = spawn("bun", args, { env: cleanEnv, stdio: ["ignore", "pipe", "pipe"] });
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
    child.on("close", (c) => resolve(c ?? -1));
    child.on("error", () => resolve(-1));
  });
  return { code, output: buf.join("") };
}

function persistLog(logName: string, output: string): void {
  try {
    writeFileSync(join(LOG_DIR, `${logName}.txt`), output);
  } catch {
    /* best-effort — artefact preservation is non-essential */
  }
}

// Anchors the Bun test-summary line. A non-zero exit AFTER a clean
// summary is treated as a #1004 post-test crash, not a real failure.
const ZERO_FAIL_RE = /^ 0 fail$/m;
const COVERAGE_PASS_RE = /PASS: All coverage thresholds met/;
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
    const args = ["test", ...opts.paths];

    const first = await runBun(args, logger, env);
    persistLog(opts.logName, first.output);
    if (first.code === 0) return { success: true };
    if (ZERO_FAIL_RE.test(first.output)) {
      logger.warn(`bun crash (exit ${first.code}) after all tests passed — treating as pass (#1004)`);
      return { success: true };
    }
    if (!opts.retryOn132 || first.code !== 132) {
      return { success: false, error: `exit ${first.code}` };
    }

    logger.warn("bun segfault (exit 132) — retrying once (#1004)");
    const second = await runBun(args, logger, env);
    persistLog(`${opts.logName}_retry`, second.output);
    if (second.code === 0) return { success: true };
    if (ZERO_FAIL_RE.test(second.output)) {
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

interface CoverageOpts {
  /** Stem used for `<TMP>/<logName>.txt` artefact preservation. */
  logName: string;
}

export function coverageWithCrashTolerance(opts: CoverageOpts): ScriptFunction {
  return async ({ logger, env }) => {
    const args = ["scripts/check-coverage.ts", "--ci"];

    const first = await runBun(args, logger, env);
    persistLog(opts.logName, first.output);
    const firstVerdict = classifyCoverage(first, logger);
    if (firstVerdict.success) return firstVerdict;
    if (first.code !== 132 && first.code !== 139) {
      return { success: false, error: `exit ${first.code}` };
    }

    logger.warn(`bun panic (exit ${first.code}) — retrying once`);
    const second = await runBun(args, logger, env);
    persistLog(`${opts.logName}_retry`, second.output);
    const secondVerdict = classifyCoverage(second, logger);
    if (secondVerdict.success) return secondVerdict;
    return { success: false, error: `exit ${second.code}` };
  };
}

function classifyCoverage({ code, output }: RunOutcome, logger: Logger): StepResult {
  if (code === 0) return { success: true };
  if (COVERAGE_PASS_RE.test(output)) {
    logger.warn(`bun crash (exit ${code}) after coverage check passed — treating as pass (#1419)`);
    return { success: true };
  }
  if (ZERO_FAIL_RE.test(output) && !FAIL_LINE_RE.test(output)) {
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
  computeKey?: (resolveBase: () => string) => string | null;
}

/**
 * Diff-aware test step for the local `--pre-push` gate. Runs only the test
 * files Bun's module graph says are affected by the diff (`bun test --changed`),
 * not the whole suite — the local gate covers the 99% blast radius in seconds;
 * the exhaustive suite + coverage ratchet stay in CI (`--ci`). See #2393.
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
  return async ({ logger, env }) => {
    // Verdict cache: skip tests when the worktree state is unchanged (#2396).
    const key = getKey(resolveBase);
    if (key) {
      const cached = lookupVerdict(repoRoot, key);
      if (cached === true) {
        logger.info("verdict cache hit — worktree state unchanged since last green run, skipping tests (#2396)");
        return { success: true };
      }
    }

    const base = resolveBase();
    logger.info(`diff-aware: running tests affected by changes since ${base} (bun test --changed)`);

    // Safe subset, parallel. control excluded (yoga-layout TDZ under --parallel, #2362).
    // --pass-with-no-tests: a diff that touches no test-reachable code is a pass, not an error.
    const main = await runBun(
      ["test", `--changed=${base}`, "--parallel", "--path-ignore-patterns=packages/control/**", "--pass-with-no-tests"],
      logger,
      env,
    );
    persistLog(opts.logName, main.output);
    const mainVerdict = classifyChangedTest(main, logger);
    if (!mainVerdict.success) {
      if (key) storeVerdict(repoRoot, key, false);
      return mainVerdict;
    }

    // control specs (sequential — yoga TDZ). Fast no-op when none changed.
    const control = await runBun(
      ["test", `--changed=${base}`, "packages/control", "--pass-with-no-tests"],
      logger,
      env,
    );
    persistLog(`${opts.logName}_control`, control.output);
    const controlVerdict = classifyChangedTest(control, logger);
    if (key) storeVerdict(repoRoot, key, controlVerdict.success);
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

function classifyChangedTest({ code, output }: RunOutcome, logger: Logger): StepResult {
  if (code === 0) return { success: true };
  if (ZERO_FAIL_RE.test(output)) {
    logger.warn(`bun crash (exit ${code}) after all changed tests passed — treating as pass (#1004)`);
    return { success: true };
  }
  return { success: false, error: `exit ${code}` };
}
