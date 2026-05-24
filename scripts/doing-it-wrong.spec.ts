import { describe, expect, it } from "bun:test";

import { runRules } from "./doing-it-wrong";

function makeLogger() {
  const messages: { level: string; msg: string }[] = [];
  return {
    logger: {
      info: (msg: string) => messages.push({ level: "info", msg }),
      warn: (msg: string) => messages.push({ level: "warn", msg }),
      error: (msg: string) => messages.push({ level: "error", msg }),
    },
    messages,
  };
}

describe("runRules", () => {
  it("returns unknownRule=true with honest ruleCount for an unknown rule id", async () => {
    const { logger, messages } = makeLogger();
    const result = await runRules({ ruleId: "no-such-rule-xyz" }, logger);

    expect(result.unknownRule).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.ruleCount).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const errorMsg = messages.find((m) => m.level === "error")?.msg;
    expect(errorMsg).toContain("no-such-rule-xyz");
    expect(errorMsg).toContain("not registered");
  });

  it("returns unknownRule=false for a valid rule run", async () => {
    const { logger } = makeLogger();
    const result = await runRules({}, logger);

    expect(result.unknownRule).toBe(false);
    expect(result.ruleCount).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
