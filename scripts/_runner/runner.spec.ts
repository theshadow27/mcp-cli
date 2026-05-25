import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCaptureLogger } from "./logger";
import { StepRunner, formatMs } from "./runner";
import type { Logger, Step } from "./types";

// Tracked temp dirs: every `mkdtempSync` in this file goes through `tempDir()`
// so afterEach can clean them up. Otherwise /tmp accumulates `runner-shell-*`
// dirs across runs (Copilot review #2390).
const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function makeLog(): { logger: Logger; entries: string[] } {
  const entries: string[] = [];
  const sink: Logger = {
    debug: (...a) => entries.push(`D ${a.join(" ")}`),
    info: (...a) => entries.push(`I ${a.join(" ")}`),
    warn: (...a) => entries.push(`W ${a.join(" ")}`),
    error: (...a) => entries.push(`E ${a.join(" ")}`),
  };
  return { logger: sink, entries };
}

function ok(name: string): Step {
  return { name, description: "x", command: async () => ({ success: true }) };
}

function fail(name: string, msg = "boom"): Step {
  return {
    name,
    description: "x",
    command: async ({ logger }) => {
      logger.error(msg);
      return { success: false, error: msg };
    },
  };
}

describe("StepRunner", () => {
  it("runs all steps in order on success and reports timing", async () => {
    const { logger, entries } = makeLog();
    const report = await new StepRunner({ logger }).add(ok("one"), ok("two")).run();
    expect(report.success).toBe(true);
    expect(report.failures).toHaveLength(0);
    const ordering = entries.filter((e) => e.includes("one") || e.includes("two"));
    expect(ordering[0]).toContain("one");
    expect(ordering[ordering.length - 1]).toContain("two");
  });

  it("stops at the first critical failure when failFast (default)", async () => {
    const { logger, entries } = makeLog();
    const report = await new StepRunner({ logger }).add(ok("one"), fail("two"), ok("three")).run();
    expect(report.success).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.step.name).toBe("two");
    expect(entries.some((e) => e.includes("three"))).toBe(false);
  });

  it("continues past non-critical failures", async () => {
    const { logger, entries } = makeLog();
    const failNonCrit: Step = { ...fail("warn"), critical: false };
    const report = await new StepRunner({ logger }).add(ok("one"), failNonCrit, ok("three")).run();
    expect(report.success).toBe(true);
    expect(report.failures).toHaveLength(1);
    expect(entries.some((e) => e.includes("three"))).toBe(true);
  });

  it("--only runs exactly one step by name substring", async () => {
    const { logger } = makeLog();
    const seen: string[] = [];
    const tag = (n: string): Step => ({
      name: n,
      description: "x",
      command: async () => {
        seen.push(n);
        return { success: true };
      },
    });
    await new StepRunner({ logger, only: "secon" }).add(tag("first"), tag("second"), tag("third")).run();
    expect(seen).toEqual(["second"]);
  });

  it("--skip omits matched steps by substring", async () => {
    const { logger } = makeLog();
    const seen: string[] = [];
    const tag = (n: string): Step => ({
      name: n,
      description: "x",
      command: async () => {
        seen.push(n);
        return { success: true };
      },
    });
    const report = await new StepRunner({ logger, skip: ["coverage"] })
      .add(tag("typecheck"), tag("lint"), tag("test-non-daemon"), tag("coverage"))
      .run();
    expect(report.success).toBe(true);
    expect(seen).toEqual(["typecheck", "lint", "test-non-daemon"]);
  });

  it("--skip accepts multiple patterns", async () => {
    const { logger } = makeLog();
    const seen: string[] = [];
    const tag = (n: string): Step => ({
      name: n,
      description: "x",
      command: async () => {
        seen.push(n);
        return { success: true };
      },
    });
    await new StepRunner({ logger, skip: ["test-daemon", "coverage"] })
      .add(tag("typecheck"), tag("test-non-daemon"), tag("test-daemon"), tag("coverage"))
      .run();
    expect(seen).toEqual(["typecheck", "test-non-daemon"]);
  });

  it("--from skips earlier steps", async () => {
    const { logger } = makeLog();
    const seen: string[] = [];
    const tag = (n: string): Step => ({
      name: n,
      description: "x",
      command: async () => {
        seen.push(n);
        return { success: true };
      },
    });
    await new StepRunner({ logger, from: "2" }).add(tag("a"), tag("b"), tag("c")).run();
    expect(seen).toEqual(["b", "c"]);
  });

  it("suppresses captured output on success, replays it on failure", async () => {
    const { logger, entries } = makeLog();
    const chatty: Step = {
      name: "chatty",
      description: "x",
      command: async ({ logger }) => {
        logger.info("hidden-on-success");
        return { success: true };
      },
    };
    await new StepRunner({ logger }).add(chatty).run();
    expect(entries.some((e) => e.includes("hidden-on-success"))).toBe(false);

    const { logger: l2, entries: e2 } = makeLog();
    const loudFail: Step = {
      name: "loud",
      description: "x",
      command: async ({ logger }) => {
        logger.error("you-must-see-this");
        return { success: false };
      },
    };
    await new StepRunner({ logger: l2 }).add(loudFail).run();
    expect(e2.some((e) => e.includes("you-must-see-this"))).toBe(true);
  });
});

describe("createCaptureLogger", () => {
  it("buffers and replays in order", () => {
    const cap = createCaptureLogger();
    cap.info("a");
    cap.warn("b");
    cap.error("c");
    const { logger, entries } = makeLog();
    cap.show(logger);
    expect(entries).toEqual(["I a", "W b", "E c"]);
  });

  it("clear() empties the buffer", () => {
    const cap = createCaptureLogger();
    cap.info("a");
    cap.clear();
    const { logger, entries } = makeLog();
    cap.show(logger);
    expect(entries).toEqual([]);
  });
});

describe("StepRunner — additional coverage", () => {
  it("--from with an unknown spec reports 'step not found' with available names", async () => {
    const { logger, entries } = makeLog();
    const report = await new StepRunner({ logger, from: "nope" }).add(ok("one"), ok("two")).run();
    expect(report.success).toBe(false);
    expect(report.failures).toHaveLength(0);
    expect(entries.some((e) => e.startsWith("E ") && e.includes("step 'nope' not found"))).toBe(true);
    expect(entries.some((e) => e.includes("one, two"))).toBe(true);
  });

  it("--only with an unknown spec reports 'step not found'", async () => {
    const { logger, entries } = makeLog();
    const report = await new StepRunner({ logger, only: "missing" }).add(ok("one")).run();
    expect(report.success).toBe(false);
    expect(entries.some((e) => e.includes("step 'missing' not found"))).toBe(true);
  });

  it("verbose: replays captured step output even on success", async () => {
    const { logger, entries } = makeLog();
    const chatty: Step = {
      name: "chatty",
      description: "x",
      command: async ({ logger }) => {
        logger.info("captured-in-success");
        return { success: true };
      },
    };
    await new StepRunner({ logger, verbose: true }).add(chatty).run();
    expect(entries.some((e) => e.includes("captured-in-success"))).toBe(true);
  });

  it("step that throws synchronously is caught and reported as failure", async () => {
    const { logger, entries } = makeLog();
    const thrower: Step = {
      name: "thrower",
      description: "x",
      command: async () => {
        throw new Error("kaboom");
      },
    };
    const report = await new StepRunner({ logger }).add(thrower).run();
    expect(report.success).toBe(false);
    expect(report.failures[0]?.error).toBe("kaboom");
    expect(entries.some((e) => e.includes("rerun: bun run am-i-done --from 1"))).toBe(true);
  });

  it("step throwing a non-Error value stringifies the value", async () => {
    const { logger } = makeLog();
    const thrower: Step = {
      name: "non-error",
      description: "x",
      command: async () => {
        throw "raw-string-thrown";
      },
    };
    const report = await new StepRunner({ logger }).add(thrower).run();
    expect(report.failures[0]?.error).toBe("raw-string-thrown");
  });

  it("function step returning true/undefined/null is treated as success", async () => {
    const { logger } = makeLog();
    const trueStep: Step = { name: "t", description: "x", command: async () => true };
    const undefStep: Step = { name: "u", description: "x", command: async () => undefined };
    const nullStep: Step = { name: "n", description: "x", command: async () => null as unknown as undefined };
    const report = await new StepRunner({ logger }).add(trueStep, undefStep, nullStep).run();
    expect(report.success).toBe(true);
    expect(report.failures).toHaveLength(0);
  });

  it("function step returning boolean false is failure", async () => {
    const { logger } = makeLog();
    const falseStep: Step = { name: "f", description: "x", command: async () => false };
    const report = await new StepRunner({ logger }).add(falseStep).run();
    expect(report.success).toBe(false);
    expect(report.failures).toHaveLength(1);
  });

  it("onFailure as a string is emitted as a single hint", async () => {
    const { logger, entries } = makeLog();
    const failStep: Step = {
      ...fail("hint-string"),
      onFailure: "single-hint",
    };
    await new StepRunner({ logger }).add(failStep).run();
    expect(entries.some((e) => e.includes("💡 single-hint"))).toBe(true);
  });

  it("onFailure as an array emits every hint", async () => {
    const { logger, entries } = makeLog();
    const failStep: Step = {
      ...fail("hint-array"),
      onFailure: ["hint-one", "hint-two"],
    };
    await new StepRunner({ logger }).add(failStep).run();
    expect(entries.some((e) => e.includes("💡 hint-one"))).toBe(true);
    expect(entries.some((e) => e.includes("💡 hint-two"))).toBe(true);
  });

  it("failFast=false continues past critical failures and reports all of them", async () => {
    const { logger } = makeLog();
    const report = await new StepRunner({ logger, failFast: false })
      .add(fail("first"), fail("second"), ok("third"))
      .run();
    expect(report.success).toBe(false);
    expect(report.failures.map((f) => f.step.name)).toEqual(["first", "second"]);
  });

  it("step.args and step.env reach the function step's StepOptions", async () => {
    const { logger } = makeLog();
    let seen: { args?: string[]; envVal?: string } = {};
    const step: Step = {
      name: "args-and-env",
      description: "x",
      command: async ({ args, env }) => {
        seen = { args, envVal: env.MCP_CLI_STEP_PROBE };
        return { success: true };
      },
      args: ["--flag", "v"],
      env: { MCP_CLI_STEP_PROBE: "abc" },
    };
    await new StepRunner({ logger }).add(step).run();
    expect(seen.args).toEqual(["--flag", "v"]);
    expect(seen.envVal).toBe("abc");
  });
});

describe("formatMs", () => {
  // Unit-tests the duration formatter directly with synthetic elapsed values —
  // avoids the wall-clock sleep the earlier version used to land in the
  // seconds branch (Copilot review #2390, also flagged by the test-timeouts rule).
  it("renders < 1s as integer milliseconds", () => {
    expect(formatMs(0)).toBe("0ms");
    expect(formatMs(1)).toBe("1ms");
    expect(formatMs(999)).toBe("999ms");
  });

  it("renders 1s through just-under-60s with one decimal", () => {
    expect(formatMs(1000)).toBe("1.0s");
    expect(formatMs(1100)).toBe("1.1s");
    expect(formatMs(59_999)).toBe("60.0s");
  });

  it("renders ≥ 60s as XmYs (minutes branch)", () => {
    expect(formatMs(60_000)).toBe("1m0s");
    expect(formatMs(65_000)).toBe("1m5s");
    // 125.5 s → floor(125.5/60)=2, round(125.5%60)=round(5.5)=6
    expect(formatMs(125_500)).toBe("2m6s");
    expect(formatMs(3_600_000)).toBe("60m0s");
  });
});

// ===== runShell: spawns a real child process via step.command: string =====
//
// Uses a temp-dir shim binary to keep the test hermetic. The shim writes to
// stdout/stderr (covering the runShell data handlers) and exits with a
// configured code (covering the close handler's success / non-zero / null
// branches). A non-existent command exercises the spawn `error` branch.

function shimScript(opts: { stdout?: string; stderr?: string; code: number }): string {
  const dir = tempDir("runner-shell-");
  const path = join(dir, "shim");
  const stdout = (opts.stdout ?? "").replace(/'/g, "'\\''");
  const stderr = (opts.stderr ?? "").replace(/'/g, "'\\''");
  writeFileSync(
    path,
    `#!/usr/bin/env bash
[ -n '${stdout}' ] && printf '%s\\n' '${stdout}'
[ -n '${stderr}' ] && printf '%s\\n' '${stderr}' >&2
exit ${opts.code}
`,
    { mode: 0o755 },
  );
  return path;
}

describe("StepRunner — runShell (string command)", () => {
  it("empty command string returns success=false with 'empty command'", async () => {
    const { logger } = makeLog();
    const empty: Step = { name: "empty", description: "x", command: "   " };
    const report = await new StepRunner({ logger }).add(empty).run();
    expect(report.success).toBe(false);
    expect(report.failures[0]?.error).toBe("empty command");
  });

  it("exit 0 from a real subprocess is a success", async () => {
    const { logger } = makeLog();
    const shim = shimScript({ stdout: "hello-stdout", code: 0 });
    const step: Step = { name: "shim-ok", description: "x", command: shim };
    const report = await new StepRunner({ logger }).add(step).run();
    expect(report.success).toBe(true);
    expect(report.failures).toHaveLength(0);
  });

  it("non-zero exit is a failure with 'exit N' error and stderr is replayed", async () => {
    const { logger, entries } = makeLog();
    const shim = shimScript({ stdout: "out-line", stderr: "err-line", code: 3 });
    const step: Step = { name: "shim-fail", description: "x", command: shim };
    const report = await new StepRunner({ logger }).add(step).run();
    expect(report.success).toBe(false);
    expect(report.failures[0]?.error).toBe("exit 3");
    // On failure the captured output is replayed to the sink — both stdout (info)
    // and stderr (error) channels should appear.
    expect(entries.some((e) => e.startsWith("I ") && e.includes("out-line"))).toBe(true);
    expect(entries.some((e) => e.startsWith("E ") && e.includes("err-line"))).toBe(true);
  });

  it("non-existent binary triggers the spawn error branch", async () => {
    const { logger } = makeLog();
    const step: Step = {
      name: "no-such-bin",
      description: "x",
      command: "/this/path/definitely/does/not/exist-xyz-12345",
    };
    const report = await new StepRunner({ logger }).add(step).run();
    expect(report.success).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.error).toBeTruthy();
  });

  it("appends step.args to the shell command's argv", async () => {
    const { logger } = makeLog();
    const dir = tempDir("runner-shell-args-");
    const path = join(dir, "argshim");
    // The shim echoes its argv joined; we'll fail it unless the arg shows up.
    writeFileSync(
      path,
      `#!/usr/bin/env bash
case "$@" in
  *MCP_PROBE*) echo "found" && exit 0 ;;
  *) echo "missing: $@" >&2 && exit 5 ;;
esac
`,
      { mode: 0o755 },
    );
    const step: Step = {
      name: "argshim",
      description: "x",
      command: path,
      args: ["MCP_PROBE"],
    };
    const report = await new StepRunner({ logger }).add(step).run();
    expect(report.success).toBe(true);
  });

  it("drops undefined env values before spawning (no upstream `unset` needed)", async () => {
    const { logger } = makeLog();
    const dir = tempDir("runner-shell-env-");
    const path = join(dir, "envshim");
    writeFileSync(
      path,
      `#!/usr/bin/env bash
# Bash converts an "unset" env var to empty; an explicit "undefined"
# literal here would fail spawn() before reaching the script.
[ "$MCP_DEFINED" = "yes" ] || exit 7
exit 0
`,
      { mode: 0o755 },
    );
    const step: Step = {
      name: "envshim",
      description: "x",
      command: path,
      env: {
        MCP_DEFINED: "yes",
        // The runner's runShell drops undefined values pre-spawn; if it didn't,
        // node:child_process.spawn would throw before ever calling exec.
        MCP_DROPPED: undefined as unknown as string,
      },
    };
    const report = await new StepRunner({ logger }).add(step).run();
    expect(report.success).toBe(true);
  });
});
