import { describe, expect, it } from "bun:test";

import { bunTestWithCrashTolerance, changedTestsStep, coverageWithCrashTolerance } from "./ci-steps";
import { createCaptureLogger } from "./logger";

// The factories spawn `bun` and inspect exit codes + output. The structured
// classification — "is this a real failure or a #1004/#1419 crash-after-pass?"
// — is the load-bearing logic. We exercise the factories against a stub `bun`
// binary whose exit code, stdout/stderr, and junit XML we control, then assert
// the returned StepResult matches the documented contract.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Derive the junit/coverage failures count from the stdout content.
 * A stdout containing " 0 fail" is a clean-run signal → 0 failures.
 */
function deriveFailures(stdout: string | undefined): number {
  return (stdout ?? "").includes(" 0 fail") ? 0 : 1;
}

function makeFakeBun(opts: { code: number; stdout?: string; stderr?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "am-i-done-test-"));
  const path = join(dir, "bun");
  const stdout = (opts.stdout ?? "").replace(/'/g, "'\\''");
  const stderr = (opts.stderr ?? "").replace(/'/g, "'\\''");
  const f = deriveFailures(opts.stdout);
  writeFileSync(
    path,
    // Write structured output files when requested so classifiers key off
    // machine-readable failure counts rather than prose (#2401):
    //   --reporter-outfile=PATH  → junit XML (bun test direct invocations)
    //   --junit-outfile=PATH     → { failures: N } JSON (check-coverage.ts path)
    `#!/usr/bin/env bash
printf '%s' '${stdout}'
printf '%s' '${stderr}' >&2
for arg in "$@"; do
  case "$arg" in
    --reporter-outfile=*)
      jpath="\${arg#--reporter-outfile=}"
      printf '<?xml version="1.0"?><testsuites failures="${f}"></testsuites>' > "$jpath"
      ;;
    --junit-outfile=*)
      cpath="\${arg#--junit-outfile=}"
      printf '{"failures":${f}}' > "$cpath"
      ;;
  esac
done
exit ${opts.code}
`,
    { mode: 0o755 },
  );
  return dir;
}

// Two-pass fake bun: first invocation behaves as pass1, subsequent as pass2.
// A counter file tracks invocations so changedTestsStep's main vs control
// passes can have distinct exit codes and outputs — essential for verifying
// short-circuit behavior (pass2 must differ from pass1 or removing the
// early return can't flip the verdict).
function makeTwoPassFakeBun(
  pass1: { code: number; stdout?: string },
  pass2: { code: number; stdout?: string },
): string {
  const dir = mkdtempSync(join(tmpdir(), "am-i-done-test-"));
  const counterFile = join(dir, ".invocation_count");
  const s1 = (pass1.stdout ?? "").replace(/'/g, "'\\''");
  const s2 = (pass2.stdout ?? "").replace(/'/g, "'\\''");
  const f1 = deriveFailures(pass1.stdout);
  const f2 = deriveFailures(pass2.stdout);
  writeFileSync(
    join(dir, "bun"),
    `#!/usr/bin/env bash
count=0
if [ -f '${counterFile}' ]; then count=$(cat '${counterFile}'); fi
count=$((count + 1))
echo "$count" > '${counterFile}'
write_files() {
  local failures="$1"
  shift
  for arg in "$@"; do
    case "$arg" in
      --reporter-outfile=*)
        jpath="\${arg#--reporter-outfile=}"
        printf '<?xml version="1.0"?><testsuites failures="%s"></testsuites>' "$failures" > "$jpath"
        ;;
      --junit-outfile=*)
        cpath="\${arg#--junit-outfile=}"
        printf '{"failures":%s}' "$failures" > "$cpath"
        ;;
    esac
  done
}
if [ "$count" -eq 1 ]; then
  printf '%s' '${s1}'
  write_files ${f1} "$@"
  exit ${pass1.code}
else
  printf '%s' '${s2}'
  write_files ${f2} "$@"
  exit ${pass2.code}
fi
`,
    { mode: 0o755 },
  );
  return dir;
}

// Echoes the value of a named env var into stdout — used to prove that
// StepOptions.env is reaching the spawned subprocess, not silently dropped.
function makeFakeBunEchoEnv(varName: string): string {
  const dir = mkdtempSync(join(tmpdir(), "am-i-done-test-"));
  const path = join(dir, "bun");
  writeFileSync(
    path,
    `#!/usr/bin/env bash
echo "PROBE=\${${varName}}"
exit 0
`,
    { mode: 0o755 },
  );
  return dir;
}

async function runWith(fakeBunDir: string, fn: () => Promise<unknown>): Promise<unknown> {
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBunDir}:${originalPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = originalPath;
  }
}

const passingSummary = "Bun test run\n\n 12 pass\n 0 fail\n";
const failingSummary = "Bun test run\n\n 11 pass\n 1 fail\n";

describe("bunTestWithCrashTolerance", () => {
  it("treats exit 0 as success", async () => {
    const dir = makeFakeBun({ code: 0, stdout: passingSummary });
    const step = bunTestWithCrashTolerance({ paths: ["packages/core"], logName: "test_x" });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toEqual({ success: true });
  });

  it("treats non-zero exit with `0 fail` summary as #1004 pass-by-policy", async () => {
    // Exit 1 AFTER tests completed — the summary is authoritative.
    const dir = makeFakeBun({ code: 1, stdout: passingSummary });
    const step = bunTestWithCrashTolerance({ paths: ["packages/core"], logName: "test_x" });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toEqual({ success: true });
  });

  it("real test failure (non-zero exit, summary shows fail count) reports failure", async () => {
    const dir = makeFakeBun({ code: 1, stdout: failingSummary });
    const step = bunTestWithCrashTolerance({ paths: ["packages/core"], logName: "test_x" });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toMatchObject({ success: false });
  });

  it("retryOn132: exit 132 first run, exit 0 retry → success", async () => {
    // The fake bun deterministically returns the same exit code each time, so
    // we exercise the no-retry path here and the retry-then-segfault path below.
    // A two-step scenario would need a counter-aware stub.
    const dir = makeFakeBun({ code: 132 });
    const step = bunTestWithCrashTolerance({ paths: ["packages/daemon"], logName: "test_x", retryOn132: true });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    // Both runs returned 132 — treated as pass per #1004 (known upstream bug).
    expect(result).toEqual({ success: true });
  });

  it("post-test crash with no junit file falls back to stdout ' 0 fail' (#1004 hybrid)", async () => {
    // The real #1004 scenario: bun crashes during teardown BEFORE flushing the
    // junit reporter to disk. The ' 0 fail' stdout line is the durable fallback
    // signal — it is written incrementally and survives a post-test crash even
    // when the sidecar file does not (#2401).
    const dir = mkdtempSync(join(tmpdir(), "am-i-done-test-"));
    const ps = passingSummary.replace(/'/g, "'\\''");
    writeFileSync(
      join(dir, "bun"),
      `#!/usr/bin/env bash
printf '%s' '${ps}'
# Deliberately write NO --reporter-outfile — simulates bun crashing before flush.
exit 139
`,
      { mode: 0o755 },
    );
    const step = bunTestWithCrashTolerance({ paths: ["packages/core"], logName: "test_no_junit" });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toEqual({ success: true });
  });

  it("no retryOn132: exit 132 with no `0 fail` summary fails", async () => {
    const dir = makeFakeBun({ code: 132 });
    const step = bunTestWithCrashTolerance({ paths: ["packages/core"], logName: "test_x", retryOn132: false });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toMatchObject({ success: false });
  });

  it("forwards StepOptions.env to the spawned subprocess (#2389 review)", async () => {
    // Regression for the env-forwarding gap: the wrapper must thread
    // StepOptions.env through runBun() into spawn(), or PATH/env overrides
    // from the runner/step never reach the bun subprocess.
    const dir = makeFakeBunEchoEnv("MCP_CLI_PROBE");
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      MCP_CLI_PROBE: "hello-from-step-env",
    };
    const step = bunTestWithCrashTolerance({ paths: ["x"], logName: "test_env_probe" });
    const result = await (
      step as (o: {
        logger: ReturnType<typeof createCaptureLogger>;
        env: Record<string, string | undefined>;
        args: string[];
      }) => Promise<unknown>
    )({ logger: createCaptureLogger(), env, args: [] });
    expect(result).toEqual({ success: true });
    const persisted = readFileSync("/tmp/test_env_probe.txt", "utf8");
    expect(persisted).toContain("PROBE=hello-from-step-env");
  });
});

describe("coverageWithCrashTolerance", () => {
  it("exit 0 is success", async () => {
    const dir = makeFakeBun({ code: 0, stdout: "PASS: All coverage thresholds met\n" });
    const step = coverageWithCrashTolerance({ logName: "coverage_x" });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toEqual({ success: true });
  });

  it("post-test crash with `PASS: All coverage thresholds met` is a pass (#1419)", async () => {
    const dir = makeFakeBun({ code: 1, stdout: "PASS: All coverage thresholds met\n" });
    const step = coverageWithCrashTolerance({ logName: "coverage_x" });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toEqual({ success: true });
  });

  it("post-test crash with `0 fail` and no `FAIL:` is a pass (#1419)", async () => {
    const dir = makeFakeBun({ code: 1, stdout: `${passingSummary}\nsome other output\n` });
    const step = coverageWithCrashTolerance({ logName: "coverage_x" });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toEqual({ success: true });
  });

  it("a `FAIL:` line in the output blocks the `0 fail` passthrough", async () => {
    // Coverage step prints "FAIL: Function coverage Z% is below..." on threshold
    // breach. Without the FAIL: guard the `0 fail` from the test summary would
    // mask a real ratchet failure.
    const dir = makeFakeBun({ code: 1, stdout: `${passingSummary}\nFAIL: Function coverage 50% is below threshold\n` });
    const step = coverageWithCrashTolerance({ logName: "coverage_x" });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toMatchObject({ success: false });
  });

  it("exit 132 with neither passthrough → retries; deterministic stub still 132 → fails on second", async () => {
    // Both runs return exit 132 with no PASS/0-fail evidence. Per the policy
    // (unlike bunTestWithCrashTolerance which treats 132-on-retry as pass),
    // coverage requires evidence of a clean run to pass — bare exit 132 retry
    // doesn't qualify.
    const dir = makeFakeBun({ code: 132, stdout: "panic on teardown" });
    const step = coverageWithCrashTolerance({ logName: "coverage_x" });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toMatchObject({ success: false });
  });

  it("exit other than 132/139 with no passthrough is a hard fail (no retry)", async () => {
    const dir = makeFakeBun({ code: 1, stdout: "some unrelated failure\n" });
    const step = coverageWithCrashTolerance({ logName: "coverage_x" });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toMatchObject({ success: false });
  });

  it("inner bun crash without junit summary falls back to stdout ' 0 fail' (#1419 hybrid)", async () => {
    // Simulates the case where check-coverage.ts writes { failures: null } because
    // an inner bun run crashed before flushing its junit XML. The outer classifier
    // must fall back to the durable stdout signal — the inner bun's ' 0 fail' line
    // piped through check-coverage.ts output (#2401).
    const dir = mkdtempSync(join(tmpdir(), "am-i-done-test-"));
    const ps = passingSummary.replace(/'/g, "'\\''");
    writeFileSync(
      join(dir, "bun"),
      `#!/usr/bin/env bash
printf '%s' '${ps}'
for arg in "$@"; do
  case "$arg" in
    --junit-outfile=*)
      cpath="\${arg#--junit-outfile=}"
      printf '{"failures":null}' > "$cpath"
      ;;
  esac
done
exit 1
`,
      { mode: 0o755 },
    );
    const step = coverageWithCrashTolerance({ logName: "coverage_null_junit" });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toEqual({ success: true });
  });

  it("inner bun crash with null summary AND real failures is a hard fail", async () => {
    // When there are real test failures (no ' 0 fail' in stdout), the null-summary
    // fallback must NOT fire — the crash masked genuine failures.
    const dir = mkdtempSync(join(tmpdir(), "am-i-done-test-"));
    const fs = failingSummary.replace(/'/g, "'\\''");
    writeFileSync(
      join(dir, "bun"),
      `#!/usr/bin/env bash
printf '%s' '${fs}'
for arg in "$@"; do
  case "$arg" in
    --junit-outfile=*)
      cpath="\${arg#--junit-outfile=}"
      printf '{"failures":null}' > "$cpath"
      ;;
  esac
done
exit 1
`,
      { mode: 0o755 },
    );
    const step = coverageWithCrashTolerance({ logName: "coverage_null_junit_fail" });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toMatchObject({ success: false });
  });
});

describe("changedTestsStep", () => {
  // resolveBase is injected so the test never shells out to git — the step
  // then spawns the fake `bun` (twice: safe subset + control pass), and we
  // assert the #1004 classification on the combined verdict.
  const stubBase = () => "STUB_BASE";
  // Disable verdict cache for all legacy tests — they don't set up a repo root.
  const noCache = () => null;

  it("exit 0 on both passes → success", async () => {
    const dir = makeFakeBun({ code: 0, stdout: passingSummary });
    const step = changedTestsStep({ logName: "test_changed_x", resolveBase: stubBase, computeKey: noCache });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toEqual({ success: true });
  });

  it("non-zero exit with `0 fail` summary is a #1004 pass-by-policy", async () => {
    const dir = makeFakeBun({ code: 1, stdout: passingSummary });
    const step = changedTestsStep({ logName: "test_changed_x", resolveBase: stubBase, computeKey: noCache });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toEqual({ success: true });
  });

  it("real failure in the safe subset short-circuits before the control pass", async () => {
    // Pass 1 (main) fails; pass 2 (control) would succeed — if the short-circuit
    // is removed, control runs and flips the verdict to success, catching the bug.
    const dir = makeTwoPassFakeBun({ code: 1, stdout: failingSummary }, { code: 0, stdout: passingSummary });
    const step = changedTestsStep({ logName: "test_changed_sc", resolveBase: stubBase, computeKey: noCache });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toMatchObject({ success: false });
  });

  it("control pass failure is reported when the main pass succeeds", async () => {
    // Pass 1 (main) succeeds; pass 2 (control) fails — exercises the second
    // classifyChangedTest return and the control-fail code path.
    const dir = makeTwoPassFakeBun({ code: 0, stdout: passingSummary }, { code: 1, stdout: failingSummary });
    const step = changedTestsStep({ logName: "test_changed_ctrl_fail", resolveBase: stubBase, computeKey: noCache });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toMatchObject({ success: false });
  });

  it("passes the resolved base ref to bun via --changed", async () => {
    // Fake bun echoes its own argv so we can prove --changed=<base> is forwarded.
    const dir = mkdtempSync(join(tmpdir(), "am-i-done-test-"));
    writeFileSync(join(dir, "bun"), '#!/usr/bin/env bash\necho "ARGV=$*"\nexit 0\n', { mode: 0o755 });
    const step = changedTestsStep({ logName: "test_changed_argv", resolveBase: stubBase, computeKey: noCache });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toEqual({ success: true });
    expect(readFileSync("/tmp/test_changed_argv.txt", "utf8")).toContain("--changed=STUB_BASE");
  });

  it("main pass carries --path-ignore-patterns for control; control pass does not carry control/**", async () => {
    // Verifies the --path-ignore-patterns + --changed interaction: main pass
    // must exclude packages/control via the flag; control pass targets it
    // directly as a positional arg (no control/** ignore flag needed).
    const dir = mkdtempSync(join(tmpdir(), "am-i-done-test-"));
    writeFileSync(join(dir, "bun"), '#!/usr/bin/env bash\necho "ARGV=$*"\nexit 0\n', { mode: 0o755 });
    const step = changedTestsStep({ logName: "test_changed_flags", resolveBase: stubBase, computeKey: noCache });
    await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    const mainLog = readFileSync("/tmp/test_changed_flags.txt", "utf8");
    const controlLog = readFileSync("/tmp/test_changed_flags_control.txt", "utf8");
    expect(mainLog).toContain("--path-ignore-patterns=packages/control/**");
    expect(controlLog).not.toContain("--path-ignore-patterns=packages/control/**");
    expect(controlLog).toContain("packages/control");
  });

  it("skips tests on verdict cache hit (passing)", async () => {
    // A fake bun that would fail — but the cache hit should prevent it from running.
    const dir = makeFakeBun({ code: 1, stdout: "SHOULD NOT RUN\n 1 fail\n" });
    const cacheRoot = mkdtempSync(join(tmpdir(), "am-i-done-cache-"));
    const { storeVerdict } = await import("./verdict-cache");
    storeVerdict(cacheRoot, "cached-key", true);

    const step = changedTestsStep({
      logName: "test_changed_cache_hit",
      resolveBase: stubBase,
      repoRoot: cacheRoot,
      computeKey: () => "cached-key",
    });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toEqual({ success: true });
  });

  it("runs tests on verdict cache miss and stores the result", async () => {
    const dir = makeFakeBun({ code: 0, stdout: passingSummary });
    const cacheRoot = mkdtempSync(join(tmpdir(), "am-i-done-cache-"));

    const step = changedTestsStep({
      logName: "test_changed_cache_miss",
      resolveBase: stubBase,
      repoRoot: cacheRoot,
      computeKey: () => "new-key",
    });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toEqual({ success: true });

    const { lookupVerdict } = await import("./verdict-cache");
    expect(lookupVerdict(cacheRoot, "new-key")).toBe(true);
  });

  it("runs tests and does not store when computeKey returns null (git unavailable)", async () => {
    const dir = makeFakeBun({ code: 0, stdout: passingSummary });
    const cacheRoot = mkdtempSync(join(tmpdir(), "am-i-done-cache-"));

    const step = changedTestsStep({
      logName: "test_changed_null_key",
      resolveBase: stubBase,
      repoRoot: cacheRoot,
      computeKey: () => null,
    });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toEqual({ success: true });
    // No verdict stored — cache file should not exist.
    expect(existsSync(join(cacheRoot, "build/.verdict-cache.json"))).toBe(false);
  });

  it("does not short-circuit on a cached failure", async () => {
    const dir = makeFakeBun({ code: 0, stdout: passingSummary });
    const cacheRoot = mkdtempSync(join(tmpdir(), "am-i-done-cache-"));
    const { storeVerdict, lookupVerdict } = await import("./verdict-cache");
    storeVerdict(cacheRoot, "fail-key", false);

    const step = changedTestsStep({
      logName: "test_changed_cache_fail",
      resolveBase: stubBase,
      repoRoot: cacheRoot,
      computeKey: () => "fail-key",
    });
    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    // Tests ran (fake bun exits 0) and overwrite the cached failure.
    expect(result).toEqual({ success: true });
    expect(lookupVerdict(cacheRoot, "fail-key")).toBe(true);
  });

  it("closure cache: skips files with unchanged closure hash, runs changed ones", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "am-i-done-closure-"));
    const dir = mkdtempSync(join(tmpdir(), "am-i-done-test-"));
    writeFileSync(join(dir, "bun"), '#!/usr/bin/env bash\necho "ARGV=$*"\nexit 0\n', { mode: 0o755 });

    const specA = join(cacheRoot, "a.spec.ts");
    const specB = join(cacheRoot, "b.spec.ts");
    const dep = join(cacheRoot, "dep.ts");
    writeFileSync(specA, 'import "./dep";\ntest("a", () => {});');
    writeFileSync(specB, 'test("b", () => {});');
    writeFileSync(dep, "export const x = 1;");

    const { buildImportGraph } = await import("../rules/_engine/import-graph");
    const { readFileCache, storeFileVerdicts, computeClosureHash } = await import("./file-cache");

    const specFiles = [specA, specB];
    const graph = buildImportGraph(specFiles, {
      readFile: (p) => readFileSync(p, "utf8"),
      resolve: (spec, fromDir) => {
        const name = spec.replace("./", "");
        return join(fromDir, `${name}.ts`);
      },
    });

    const hashA = computeClosureHash(specA, graph, (p) => readFileSync(p, "utf8"));
    const hashB = computeClosureHash(specB, graph, (p) => readFileSync(p, "utf8"));

    const cache = readFileCache(cacheRoot);
    const { relative } = await import("node:path");
    storeFileVerdicts(cache, [
      { relPath: relative(cacheRoot, specA), closureHash: hashA, passed: true },
      { relPath: relative(cacheRoot, specB), closureHash: hashB, passed: true },
    ]);
    const { writeFileCache } = await import("./file-cache");
    writeFileCache(cacheRoot, cache);

    writeFileSync(dep, "export const x = 2;");

    const step = changedTestsStep({
      logName: "test_closure_skip",
      resolveBase: stubBase,
      repoRoot: cacheRoot,
      computeKey: noCache,
      findSpecFiles: () => specFiles,
      buildGraph: (files) =>
        buildImportGraph(files, {
          readFile: (p) => readFileSync(p, "utf8"),
          resolve: (spec, fromDir) => {
            const name = spec.replace("./", "");
            return join(fromDir, `${name}.ts`);
          },
        }),
    });

    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toEqual({ success: true });

    const mainLog = readFileSync("/tmp/test_closure_skip.txt", "utf8");
    const relB = relative(cacheRoot, specB);
    expect(mainLog).toContain(`--path-ignore-patterns=${relB}`);
    const relA = relative(cacheRoot, specA);
    expect(mainLog).not.toContain(`--path-ignore-patterns=${relA}`);
  });

  it("closure cache: records verdicts only for non-skipped files after run", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "am-i-done-closure-"));
    const dir = makeFakeBun({ code: 0, stdout: passingSummary });

    const specA = join(cacheRoot, "a.spec.ts");
    const specB = join(cacheRoot, "b.spec.ts");
    writeFileSync(specA, 'test("a", () => {});');
    writeFileSync(specB, 'test("b", () => {});');

    const { buildImportGraph } = await import("../rules/_engine/import-graph");
    const { readFileCache, storeFileVerdicts, computeClosureHash } = await import("./file-cache");

    const specFiles = [specA, specB];
    const trivialBuild = (files: string[]) =>
      buildImportGraph(files, {
        readFile: (p) => readFileSync(p, "utf8"),
        resolve: () => {
          throw new Error("no deps");
        },
      });

    const graph = trivialBuild(specFiles);
    const hashB = computeClosureHash(specB, graph, (p) => readFileSync(p, "utf8"));
    const cache = readFileCache(cacheRoot);
    const { relative } = await import("node:path");
    storeFileVerdicts(cache, [{ relPath: relative(cacheRoot, specB), closureHash: hashB, passed: true }]);
    const { writeFileCache } = await import("./file-cache");
    writeFileCache(cacheRoot, cache);

    const step = changedTestsStep({
      logName: "test_closure_verdicts",
      resolveBase: stubBase,
      repoRoot: cacheRoot,
      computeKey: noCache,
      findSpecFiles: () => specFiles,
      buildGraph: trivialBuild,
    });

    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toEqual({ success: true });

    const updatedCache = readFileCache(cacheRoot);
    const relA = relative(cacheRoot, specA);
    const relB = relative(cacheRoot, specB);
    expect(updatedCache.entries[relA]).toBeDefined();
    expect(updatedCache.entries[relA]?.passed).toBe(true);
    expect(updatedCache.entries[relB]).toBeDefined();
  });

  it("closure cache: controlSkipPatterns only forwards packages/control/ entries to the control pass", async () => {
    // Verifies that when closure-cached skipped files include both packages/control/
    // paths and non-control paths, the control pass receives only the control-prefixed
    // skip patterns — non-control skip patterns must not leak into the control invocation.
    const cacheRoot = mkdtempSync(join(tmpdir(), "am-i-done-ctrl-skip-"));
    const dir = mkdtempSync(join(tmpdir(), "am-i-done-test-"));
    writeFileSync(join(dir, "bun"), '#!/usr/bin/env bash\necho "ARGV=$*"\nexit 0\n', { mode: 0o755 });

    // One spec under packages/control/ (will appear in controlSkipPatterns).
    // One spec at root level (must NOT appear in controlSkipPatterns).
    const controlSpecDir = join(cacheRoot, "packages", "control");
    mkdirSync(controlSpecDir, { recursive: true });
    const specControl = join(controlSpecDir, "c.spec.ts");
    const specOther = join(cacheRoot, "other.spec.ts");
    writeFileSync(specControl, 'test("c", () => {});');
    writeFileSync(specOther, 'test("other", () => {});');

    const { buildImportGraph } = await import("../rules/_engine/import-graph");
    const { readFileCache, storeFileVerdicts, computeClosureHash, writeFileCache } = await import("./file-cache");
    const { relative } = await import("node:path");

    const specFiles = [specControl, specOther];
    const trivialBuild = (files: string[]) =>
      buildImportGraph(files, {
        readFile: (p) => readFileSync(p, "utf8"),
        resolve: () => {
          throw new Error("no deps");
        },
      });

    const graph = trivialBuild(specFiles);
    const hashControl = computeClosureHash(specControl, graph, (p) => readFileSync(p, "utf8"));
    const hashOther = computeClosureHash(specOther, graph, (p) => readFileSync(p, "utf8"));

    const cache = readFileCache(cacheRoot);
    storeFileVerdicts(cache, [
      { relPath: relative(cacheRoot, specControl), closureHash: hashControl, passed: true },
      { relPath: relative(cacheRoot, specOther), closureHash: hashOther, passed: true },
    ]);
    writeFileCache(cacheRoot, cache);

    const step = changedTestsStep({
      logName: "test_ctrl_skip_patterns",
      resolveBase: stubBase,
      repoRoot: cacheRoot,
      computeKey: noCache,
      findSpecFiles: () => specFiles,
      buildGraph: trivialBuild,
    });

    const result = await runWith(dir, () =>
      (step as (o: { logger: ReturnType<typeof createCaptureLogger> }) => Promise<unknown>)({
        logger: createCaptureLogger(),
      }),
    );
    expect(result).toEqual({ success: true });

    const mainLog = readFileSync("/tmp/test_ctrl_skip_patterns.txt", "utf8");
    const controlLog = readFileSync("/tmp/test_ctrl_skip_patterns_control.txt", "utf8");
    const relControl = relative(cacheRoot, specControl); // "packages/control/c.spec.ts"
    const relOther = relative(cacheRoot, specOther); // "other.spec.ts"

    // Main pass gets skip patterns for both closure-cached files.
    expect(mainLog).toContain(`--path-ignore-patterns=${relControl}`);
    expect(mainLog).toContain(`--path-ignore-patterns=${relOther}`);

    // Control pass gets only the packages/control/ skip pattern — not the root-level one.
    expect(controlLog).toContain(`--path-ignore-patterns=${relControl}`);
    expect(controlLog).not.toContain(`--path-ignore-patterns=${relOther}`);
  });
});
