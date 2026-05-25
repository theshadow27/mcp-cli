import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAiFileLogger, createCaptureLogger, createConsoleLogger } from "./logger";

// Wait long enough for createWriteStream's deferred fs.open() to land an inode
// on disk before we manually unlink it to exercise finalize's catch branch.
const STREAM_FLUSH_MS = 20;

// console.* is reassigned per-test to capture calls and restored in afterEach.
// This is property reassignment on a global object, NOT mock.module() — Bun's
// global module registry stays clean across tests.
function spy(): ((...a: unknown[]) => void) & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fn = (...a: unknown[]) => {
    calls.push(a);
  };
  return Object.assign(fn, { calls });
}

describe("createConsoleLogger", () => {
  const saved = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  let debugSpy: ReturnType<typeof spy>;
  let infoSpy: ReturnType<typeof spy>;
  let warnSpy: ReturnType<typeof spy>;
  let errorSpy: ReturnType<typeof spy>;

  beforeEach(() => {
    debugSpy = spy();
    infoSpy = spy();
    warnSpy = spy();
    errorSpy = spy();
    console.debug = debugSpy as unknown as typeof console.debug;
    console.info = infoSpy as unknown as typeof console.info;
    console.warn = warnSpy as unknown as typeof console.warn;
    console.error = errorSpy as unknown as typeof console.error;
  });

  afterEach(() => {
    console.debug = saved.debug;
    console.info = saved.info;
    console.warn = saved.warn;
    console.error = saved.error;
  });

  it("forwards each level to the corresponding console method", () => {
    const logger = createConsoleLogger();
    logger.debug("d", 1);
    logger.info("i", 2);
    logger.warn("w", 3);
    logger.error("e", 4);
    expect(debugSpy.calls).toEqual([["d", 1]]);
    expect(infoSpy.calls).toEqual([["i", 2]]);
    expect(warnSpy.calls).toEqual([["w", 3]]);
    expect(errorSpy.calls).toEqual([["e", 4]]);
  });
});

describe("createAiFileLogger", () => {
  let root: string;
  const savedWarn = console.warn;
  const savedError = console.error;
  let warnSpy: ReturnType<typeof spy>;
  let errorSpy: ReturnType<typeof spy>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ai-logger-"));
    warnSpy = spy();
    errorSpy = spy();
    console.warn = warnSpy as unknown as typeof console.warn;
    console.error = errorSpy as unknown as typeof console.error;
  });

  afterEach(() => {
    console.warn = savedWarn;
    console.error = savedError;
    // force: true makes ENOENT a no-op; any other error should surface.
    rmSync(root, { recursive: true, force: true });
  });

  it("writes info/debug only to file, mirrors warn/error to stderr", async () => {
    const logger = createAiFileLogger(root);
    expect(logger.path.startsWith(join(root, "build", "am-i-done-"))).toBe(true);
    expect(logger.path.endsWith(".txt")).toBe(true);

    logger.debug("debug-only-line");
    logger.info("info-only-line");
    logger.warn("warn-mirrored");
    logger.error("error-mirrored");
    await logger.finalize(false);

    expect(existsSync(logger.path)).toBe(true);
    const content = readFileSync(logger.path, "utf8");
    expect(content).toContain("[DEBUG] debug-only-line");
    expect(content).toContain("[INFO] info-only-line");
    expect(content).toContain("[WARN] warn-mirrored");
    expect(content).toContain("[ERROR] error-mirrored");

    // Mirror semantics: only warn/error went to console, not debug/info.
    expect(warnSpy.calls).toEqual([["warn-mirrored"]]);
    expect(errorSpy.calls).toEqual([["error-mirrored"]]);
  });

  it("strips ANSI escape sequences from output", async () => {
    const logger = createAiFileLogger(root);
    // \x1b[31m = red, \x1b[0m = reset
    logger.info("\x1b[31mred-text\x1b[0m plain");
    await logger.finalize(false);
    const content = readFileSync(logger.path, "utf8");
    expect(content).toContain("[INFO] red-text plain");
    expect(content).not.toContain("\x1b[");
  });

  it("formats Error with stack when available, falls back to message", async () => {
    const logger = createAiFileLogger(root);
    const err = new Error("boom");
    logger.error(err);
    // Synthetic Error with no stack — format() falls back to .message
    const noStack = new Error("no-stack");
    (noStack as Error).stack = undefined;
    logger.error(noStack);
    // Plain object — format() uses JSON.stringify
    logger.info({ k: "v" });
    await logger.finalize(false);
    const content = readFileSync(logger.path, "utf8");
    expect(content).toContain("boom");
    expect(content).toContain("no-stack");
    expect(content).toContain('{"k":"v"}');
  });

  it("finalize(true) deletes the log file on success", async () => {
    const logger = createAiFileLogger(root);
    logger.info("transient");
    await logger.finalize(true);
    expect(existsSync(logger.path)).toBe(false);
  });

  it("finalize(true) tolerates the file having been removed already", async () => {
    const logger = createAiFileLogger(root);
    logger.info("x");
    // Force the stream to flush and the underlying fd to exist on disk so we
    // can pre-delete and exercise the unlink-failure catch branch in finalize.
    await new Promise<void>((res) => setTimeout(res, STREAM_FLUSH_MS));
    if (existsSync(logger.path)) unlinkSync(logger.path);
    await expect(logger.finalize(true)).resolves.toBeUndefined();
  });

  it("finalize(false) preserves the log file for inspection", async () => {
    const logger = createAiFileLogger(root);
    logger.info("kept-for-debugging");
    await logger.finalize(false);
    expect(existsSync(logger.path)).toBe(true);
  });
});

describe("createCaptureLogger", () => {
  it("buffers all four levels and replays them in insertion order", () => {
    const cap = createCaptureLogger();
    cap.debug("d-msg");
    cap.info("i-msg");
    cap.warn("w-msg");
    cap.error("e-msg");

    const seen: string[] = [];
    cap.show({
      debug: (...a) => seen.push(`D ${a.join(" ")}`),
      info: (...a) => seen.push(`I ${a.join(" ")}`),
      warn: (...a) => seen.push(`W ${a.join(" ")}`),
      error: (...a) => seen.push(`E ${a.join(" ")}`),
    });
    expect(seen).toEqual(["D d-msg", "I i-msg", "W w-msg", "E e-msg"]);
  });

  it("clear() empties the buffer so a later show() produces nothing", () => {
    const cap = createCaptureLogger();
    cap.info("dropped");
    cap.clear();
    const seen: unknown[] = [];
    cap.show({
      debug: (...a) => seen.push(a),
      info: (...a) => seen.push(a),
      warn: (...a) => seen.push(a),
      error: (...a) => seen.push(a),
    });
    expect(seen).toEqual([]);
  });

  it("show() can be called multiple times — replay is non-destructive", () => {
    const cap = createCaptureLogger();
    cap.info("once");

    const first: unknown[] = [];
    const second: unknown[] = [];
    const mk = (sink: unknown[]) => ({
      debug: (...a: unknown[]) => sink.push(a),
      info: (...a: unknown[]) => sink.push(a),
      warn: (...a: unknown[]) => sink.push(a),
      error: (...a: unknown[]) => sink.push(a),
    });
    cap.show(mk(first));
    cap.show(mk(second));
    expect(first).toEqual([["once"]]);
    expect(second).toEqual([["once"]]);
  });
});
