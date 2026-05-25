import { describe, expect, it } from "bun:test";

import { bunTestWithCrashTolerance, coverageWithCrashTolerance } from "./ci-steps";
import { createCaptureLogger } from "./logger";

// The factories spawn `bun` and inspect exit codes + output. The regex
// classification — "is this a real failure or a #1004/#1419 crash-after-pass?"
// — is the load-bearing logic. We exercise the factories against a stub
// `bun` binary whose exit code and stdout/stderr we control via env vars,
// then assert the returned StepResult matches the documented contract.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeFakeBun(opts: { code: number; stdout?: string; stderr?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "am-i-done-test-"));
  const path = join(dir, "bun");
  const stdout = (opts.stdout ?? "").replace(/'/g, "'\\''");
  const stderr = (opts.stderr ?? "").replace(/'/g, "'\\''");
  writeFileSync(
    path,
    `#!/usr/bin/env bash
printf '%s' '${stdout}'
printf '%s' '${stderr}' >&2
exit ${opts.code}
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
});
