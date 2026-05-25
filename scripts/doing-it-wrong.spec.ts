import { describe, expect, it } from "bun:test";

import { runRules } from "./doing-it-wrong";
import { loadAllRules } from "./rules/index";

function makeLogger() {
  const messages: { level: string; msg: string }[] = [];
  return {
    logger: {
      debug: (msg: string) => messages.push({ level: "debug", msg }),
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
    const allRules = await loadAllRules();
    const result = await runRules({ ruleId: "no-such-rule-xyz" }, logger);

    expect(result.unknownRule).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.ruleCount).toBe(allRules.length);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const errorMsg = messages.find((m) => m.level === "error")?.msg;
    expect(errorMsg).toContain("no-such-rule-xyz");
    expect(errorMsg).toContain("not registered");
  });

  it("returns unknownRule=false for a valid rule run", async () => {
    const { logger } = makeLogger();
    const result = await runRules({ ruleId: "shell-injection", filter: "scripts/doing-it-wrong.ts" }, logger);

    expect(result.unknownRule).toBe(false);
    expect(result.ruleCount).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("hard-errors when a cross-file rule's anchor is missing from the loaded set", async () => {
    // cli-surface-registered declares packages/command/src/commands/completions.ts
    // as an anchor. Filtering by a substring that excludes it MUST surface a
    // missing-anchor failure instead of silently passing.
    const { logger, messages } = makeLogger();
    const result = await runRules({ ruleId: "cli-surface-registered", filter: "scripts/doing-it-wrong.ts" }, logger);

    expect(result.unknownRule).toBe(false);
    expect(result.missingAnchors).toHaveLength(1);
    expect(result.missingAnchors[0]?.ruleId).toBe("cli-surface-registered");
    expect(result.missingAnchors[0]?.missing).toContain("packages/command/src/commands/completions.ts");

    const errorMsg = messages.find((m) => m.level === "error" && m.msg.includes("cli-surface-registered"))?.msg;
    expect(errorMsg).toBeDefined();
    expect(errorMsg).toContain("not present in the loaded set");
    expect(errorMsg).toContain("silently pass");
  });

  it("skips evaluation of rules whose anchors are missing (no secondary violations)", async () => {
    // Realistic rename scenario: main.ts is loaded but completions.ts is not.
    // The MissingAnchorError must be the dominant signal — the rule body must
    // NOT also run and produce misleading secondary violations.
    const { logger } = makeLogger();
    const result = await runRules({ ruleId: "cli-surface-registered", filter: "packages/command/src/main.ts" }, logger);
    expect(result.missingAnchors).toHaveLength(1);
    // No spurious "SUBCOMMANDS anchor not found" violation on main.ts —
    // the anchor failure is the sole signal.
    expect(result.violations).toEqual([]);
  });

  it("passes cleanly on the real repo when all anchor files are loaded", async () => {
    // Belt + suspenders for #2315: the migration to engine-level anchors must
    // not regress existing cli-surface-registered behavior on the full tree.
    const { logger } = makeLogger();
    const result = await runRules({ ruleId: "cli-surface-registered" }, logger);
    expect(result.unknownRule).toBe(false);
    expect(result.missingAnchors).toEqual([]);
    expect(result.violations).toEqual([]);
    // The rule scans many files but only "inspects" the anchor pair + any
    // commands/ file with a KNOWN_FLAGS declaration — silent-pass should
    // NOT trip because the anchors guarantee real inspection work.
    expect(result.silentPassRules).not.toContain("cli-surface-registered");
  });
});
