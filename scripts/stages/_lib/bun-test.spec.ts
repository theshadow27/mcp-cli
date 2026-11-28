import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger, StageOptions } from "am-i-done";
import { tmpDir } from "am-i-done/tmp";

import {
  type BunRunner,
  type Ctx,
  LOG_DIR,
  type RunOutcome,
  checkDiscoveryFloor,
  classifyCoverage,
  hasZeroFailures,
  isBunPanic,
  joinOutputs,
  parseCoverageSummary,
  parseJunitFailures,
  parseJunitTests,
  persistLog,
  realRunner,
  testTolerantNoRetry,
  testWithCrashTolerance,
} from "./bun-test";
import { changedRuns, resolveBase } from "./changed";
import { countSpecFiles, dirScoped, dirScopedRun } from "./dir-scoped";
import { ciPartition, orphanTolerantSubset, partitionRun } from "./partition";
import { ORPHAN_TOLERANT_TEST_FILES } from "./test-paths";

const quiet = (): Logger & { lines: string[] } => {
  const lines: string[] = [];
  const at =
    (level: string) =>
    (...args: unknown[]) =>
      void lines.push(`${level} ${args.join(" ")}`);
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
};

const outcome = (o: Partial<RunOutcome>): RunOutcome => ({
  code: 0,
  signal: null,
  output: "",
  junitFailures: null,
  junitTests: null,
  ...o,
});

/** A runner that returns the given outcomes in order and records each call. */
function scripted(...outcomes: Partial<RunOutcome>[]): BunRunner & { calls: { argv: string[]; cwd: string }[] } {
  const calls: { argv: string[]; cwd: string }[] = [];
  const run = (async (argv: string[], { cwd }: { cwd: string }) => {
    calls.push({ argv, cwd });
    const next = outcomes.shift();
    if (next === undefined) throw new Error(`unexpected run: ${argv.join(" ")}`);
    return outcome(next);
  }) as unknown as BunRunner & { calls: { argv: string[]; cwd: string }[] };
  run.calls = calls;
  return run;
}

function ctxWith(run: BunRunner, root: string): Ctx & { logger: ReturnType<typeof quiet> } {
  return { root, logger: quiet(), run };
}

describe("parsers", () => {
  it("sums junit failures and errors", () => {
    expect(parseJunitFailures('<testsuites tests="4" failures="1" errors="2">')).toBe(3);
    expect(parseJunitFailures('<testsuites errors="1">')).toBe(1);
    expect(parseJunitFailures("<testsuites>")).toBeNull();
    expect(parseJunitFailures(null)).toBeNull();
  });

  it("reads the root tests attribute", () => {
    expect(parseJunitTests('<testsuites tests="7"><testsuite tests="3">')).toBe(7);
    expect(parseJunitTests("<x/>")).toBeNull();
    expect(parseJunitTests(null)).toBeNull();
  });

  it("reads the coverage summary", () => {
    expect(parseCoverageSummary('{"failures":0}')).toBe(0);
    expect(parseCoverageSummary('{"other":1}')).toBeNull();
    expect(parseCoverageSummary("not json")).toBeNull();
    expect(parseCoverageSummary(null)).toBeNull();
  });

  it("knows a Bun panic by exit code or by signal (#2754)", () => {
    expect(isBunPanic(132, null)).toBe(true);
    expect(isBunPanic(139, null)).toBe(true);
    for (const s of ["SIGSEGV", "SIGILL", "SIGBUS", "SIGTRAP", "SIGABRT"]) expect(isBunPanic(-1, s)).toBe(true);
    expect(isBunPanic(1, null)).toBe(false);
    expect(isBunPanic(-1, "SIGTERM")).toBe(false);
  });

  it("zero failures: junit first, the summary line only when junit is missing", () => {
    expect(hasZeroFailures(outcome({ junitFailures: 0 }))).toBe(true);
    expect(hasZeroFailures(outcome({ junitFailures: 1, output: " 0 fail" }))).toBe(false);
    expect(hasZeroFailures(outcome({ output: " 5 pass\n 0 fail\n" }))).toBe(true);
    expect(hasZeroFailures(outcome({ output: "# Unhandled error between tests\n 0 fail\n" }))).toBe(false);
    expect(hasZeroFailures(outcome({ output: " 0 fail\n 1 error\n" }))).toBe(false);
  });

  it("joins outputs", () => {
    expect(joinOutputs([{ output: "a" }, {}, { output: "b" }])).toBe("a\n\nb");
  });
});

describe("testWithCrashTolerance", () => {
  const test = (root: string) => ({ argv: ["test", "x"], name: "t", cwd: root });

  it("exit 0 passes and keeps the log", async () => {
    using dir = tmpDir("bt-");
    const r = await testWithCrashTolerance(ctxWith(scripted({ output: "ok" }), dir.path), test(dir.path));
    expect(r.success).toBe(true);
    expect(readFileSync(join(dir.path, LOG_DIR, "t.txt"), "utf8")).toBe("ok");
  });

  it("a crash after a clean summary is a pass (#1004)", async () => {
    using dir = tmpDir("bt-");
    const ctx = ctxWith(scripted({ code: 1, output: " 0 fail\n" }), dir.path);
    expect((await testWithCrashTolerance(ctx, test(dir.path))).success).toBe(true);
    expect(ctx.logger.lines.some((l) => l.includes("#1004"))).toBe(true);
  });

  it("a real failure fails without a retry", async () => {
    using dir = tmpDir("bt-");
    const run = scripted({ code: 1, output: " 2 fail\n" });
    const r = await testWithCrashTolerance(ctxWith(run, dir.path), test(dir.path));
    expect(r).toMatchObject({ success: false, error: "exit 1" });
    expect(run.calls).toHaveLength(1);
  });

  it("an unhandled error between tests fails (#2669)", async () => {
    using dir = tmpDir("bt-");
    const run = scripted({ code: 1, junitFailures: 1, output: " 0 fail\n" });
    expect((await testWithCrashTolerance(ctxWith(run, dir.path), test(dir.path))).success).toBe(false);
  });

  it("a panic is retried once; a clean retry passes (#2754)", async () => {
    using dir = tmpDir("bt-");
    const run = scripted({ code: -1, signal: "SIGSEGV" }, { code: 0, output: "fine" });
    const r = await testWithCrashTolerance(ctxWith(run, dir.path), test(dir.path));
    expect(r.success).toBe(true);
    expect(run.calls).toHaveLength(2);
    expect(existsSync(join(dir.path, LOG_DIR, "t_retry.txt"))).toBe(true);
  });

  it("a panic then a crash after a clean summary passes", async () => {
    using dir = tmpDir("bt-");
    const run = scripted({ code: 132 }, { code: 132, output: " 0 fail\n" });
    expect((await testWithCrashTolerance(ctxWith(run, dir.path), test(dir.path))).success).toBe(true);
  });

  it("two panics with no pass evidence fail (#2780)", async () => {
    using dir = tmpDir("bt-");
    const run = scripted({ code: 132 }, { code: 132 });
    expect(await testWithCrashTolerance(ctxWith(run, dir.path), test(dir.path))).toMatchObject({
      success: false,
      error: "exit 132",
    });
  });

  it("SIGTERM is not a panic and is not retried", async () => {
    using dir = tmpDir("bt-");
    const run = scripted({ code: -1, signal: "SIGTERM" });
    expect((await testWithCrashTolerance(ctxWith(run, dir.path), test(dir.path))).success).toBe(false);
    expect(run.calls).toHaveLength(1);
  });
});

describe("testTolerantNoRetry", () => {
  it("passes on exit 0 or a crash after a clean summary, and never retries", async () => {
    using dir = tmpDir("bt-");
    const t = { argv: ["test"], name: "n", cwd: dir.path };
    expect((await testTolerantNoRetry(ctxWith(scripted({}), dir.path), t)).success).toBe(true);
    expect((await testTolerantNoRetry(ctxWith(scripted({ code: 1, junitFailures: 0 }), dir.path), t)).success).toBe(
      true,
    );
    const run = scripted({ code: 132 });
    expect((await testTolerantNoRetry(ctxWith(run, dir.path), t)).success).toBe(false);
    expect(run.calls).toHaveLength(1);
  });
});

describe("checkDiscoveryFloor (#2719)", () => {
  it("prefers the summary's file count", () => {
    const o = outcome({ output: "Ran 9 tests across 3 files.", junitTests: 1 });
    expect(checkDiscoveryFloor(o, 3).success).toBe(true);
    expect(checkDiscoveryFloor(o, 4).success).toBe(false);
  });

  it("falls back to the junit test count, and fails closed with neither", () => {
    expect(checkDiscoveryFloor(outcome({ junitTests: 5 }), 3).success).toBe(true);
    expect(checkDiscoveryFloor(outcome({ junitTests: 0 }), 1).success).toBe(false);
    expect(checkDiscoveryFloor(outcome({}), 1).error).toContain("failing closed");
  });
});

describe("classifyCoverage (#1419)", () => {
  it("passes on exit 0, or on a crash after the ratchet passed", () => {
    expect(classifyCoverage(outcome({}), null).success).toBe(true);
    expect(classifyCoverage(outcome({ code: 1, output: "PASS: All coverage thresholds met\n" }), null).success).toBe(
      true,
    );
    expect(classifyCoverage(outcome({ code: 1, output: " 0 fail\n" }), null).success).toBe(true);
    expect(classifyCoverage(outcome({ code: 1 }), 0).success).toBe(true);
  });

  it("a FAIL: line wins over any PASS text, including a test name that quotes it (#2744)", () => {
    const output = "(pass) x > `PASS: All coverage thresholds met`\nFAIL: lines 60 < 69\n 0 fail\n";
    expect(classifyCoverage(outcome({ code: 1, output }), 0).success).toBe(false);
    expect(
      classifyCoverage(outcome({ code: 1, output: "PASS: All coverage thresholds met\nFAIL: x\n" }), null).success,
    ).toBe(false);
  });

  it("real failures fail", () => {
    expect(classifyCoverage(outcome({ code: 1, output: " 3 fail\n" }), 3)).toMatchObject({
      success: false,
      error: "exit 1",
    });
  });
});

describe("partitionRun", () => {
  it("selects the orphan-tolerant files a path list reaches", () => {
    expect(orphanTolerantSubset(["test/"])).toEqual([...ORPHAN_TOLERANT_TEST_FILES]);
    expect(orphanTolerantSubset(["test"])).toEqual([...ORPHAN_TOLERANT_TEST_FILES]);
    expect(orphanTolerantSubset(["packages/core"])).toEqual([]);
  });

  it("runs orphan-tolerant files separately, without --no-orphans (#619)", async () => {
    using dir = tmpDir("bt-");
    const run = scripted({ output: "a" }, { output: "b" });
    const r = await partitionRun(ctxWith(run, dir.path), ["test/"], "d")();
    expect(r.success).toBe(true);
    expect(run.calls[0]?.argv).toContain("--no-orphans");
    expect(run.calls[0]?.argv).toContain(`--path-ignore-patterns=${ORPHAN_TOLERANT_TEST_FILES[0]}`);
    expect(run.calls[1]?.argv).toEqual(["test", ...ORPHAN_TOLERANT_TEST_FILES]);
  });

  it("stops after a failing main run, and runs once when no tolerant file is reached", async () => {
    using dir = tmpDir("bt-");
    const failing = scripted({ code: 1, output: " 1 fail\n" });
    expect((await partitionRun(ctxWith(failing, dir.path), ["test/"], "d")()).success).toBe(false);
    expect(failing.calls).toHaveLength(1);
    const plain = scripted({});
    expect((await partitionRun(ctxWith(plain, dir.path), ["packages/core"], "d")()).success).toBe(true);
    expect(plain.calls).toHaveLength(1);
  });
});

describe("dirScopedRun", () => {
  it("runs from the spec directory and holds the discovery floor", async () => {
    using dir = tmpDir("bt-");
    await Bun.write(join(dir.path, "specs/a.spec.ts"), "");
    await Bun.write(join(dir.path, "specs/b.spec.ts"), "");
    expect(countSpecFiles(join(dir.path, "specs"))).toBe(2);
    const run = scripted({ output: "Ran 2 tests across 2 files." });
    expect((await dirScopedRun(ctxWith(run, dir.path), "specs", "s")).success).toBe(true);
    expect(run.calls[0]?.cwd).toBe(join(dir.path, "specs"));
    const short = scripted({ output: "Ran 1 tests across 1 files." });
    expect((await dirScopedRun(ctxWith(short, dir.path), "specs", "s")).success).toBe(false);
  });

  it("fails on an empty directory and on a failing run", async () => {
    using dir = tmpDir("bt-");
    expect((await dirScopedRun(ctxWith(scripted(), dir.path), "none", "s")).error).toContain("0 spec files");
    await Bun.write(join(dir.path, "specs/a.spec.ts"), "");
    expect((await dirScopedRun(ctxWith(scripted({ code: 1 }), dir.path), "specs", "s")).success).toBe(false);
  });
});

describe("changedRuns", () => {
  it("runs the three passes with --changed and --pass-with-no-tests", async () => {
    using dir = tmpDir("bt-");
    const run = scripted({}, {}, {});
    expect((await changedRuns(ctxWith(run, dir.path), "abc123")).success).toBe(true);
    expect(run.calls).toHaveLength(3);
    for (const c of run.calls) {
      expect(c.argv).toContain("--changed=abc123");
      expect(c.argv).toContain("--pass-with-no-tests");
    }
    expect(run.calls[0]?.argv).toContain("--path-ignore-patterns=packages/control/**");
    expect(run.calls[1]?.argv).toContain("packages/control");
    expect(run.calls[2]?.argv).not.toContain("--no-orphans");
  });

  it("stops at the first failing pass", async () => {
    using dir = tmpDir("bt-");
    const run = scripted({}, { code: 1, output: " 1 fail\n" });
    const r = await changedRuns(ctxWith(run, dir.path), "base");
    expect(r.success).toBe(false);
    expect(r.error).toContain("test_changed_control");
    expect(run.calls).toHaveLength(2);
  });

  it("resolves a base ref, falling back to HEAD~1 outside a repository", () => {
    using dir = tmpDir("bt-");
    expect(resolveBase(dir.path)).toBe("HEAD~1");
  });
});

describe("realRunner and persistLog", () => {
  it("runs bun, captures output, and reads the junit report of a bun test run", async () => {
    using dir = tmpDir("bt-");
    await Bun.write(join(dir.path, "a.spec.ts"), 'import { test } from "bun:test";\ntest("a", () => {});\n');
    const logger = quiet();
    const options = {
      root: dir.path,
      env: process.env,
      logger,
      signal: new AbortController().signal,
    } as unknown as StageOptions;
    const run = realRunner(options);
    const echoed = await run(["-e", "console.log('hi')"], { cwd: dir.path, junit: true });
    expect(echoed).toMatchObject({ code: 0, junitFailures: null });
    expect(echoed.output).toContain("hi");
    const tested = await run(["test", "./a.spec.ts"], { cwd: dir.path, junit: true });
    expect(tested).toMatchObject({ code: 0, junitFailures: 0, junitTests: 1 });
  });

  it("the stage factories run real bun from the right directory", async () => {
    using dir = tmpDir("bt-");
    await Bun.write(join(dir.path, "hooks/a.spec.ts"), 'import { test } from "bun:test";\ntest("a", () => {});\n');
    const options = {
      root: dir.path,
      env: process.env,
      logger: quiet(),
      signal: new AbortController().signal,
    } as unknown as StageOptions;
    expect(await dirScoped("hooks", "h")(options)).toMatchObject({ success: true });
    expect(await ciPartition(["hooks"], "p")(options)).toMatchObject({ success: true });
  });

  it("persistLog never throws", () => {
    using dir = tmpDir("bt-");
    persistLog(dir.path, "x", "y");
    expect(readFileSync(join(dir.path, LOG_DIR, "x.txt"), "utf8")).toBe("y");
    expect(() => persistLog("/dev/null/not-a-dir", "x", "y")).not.toThrow();
  });
});
