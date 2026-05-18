import { describe, expect, it } from "bun:test";

import { createCaptureLogger } from "./logger";
import { StepRunner } from "./runner";
import type { Logger, Step } from "./types";

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
