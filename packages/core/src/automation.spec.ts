import { describe, expect, test } from "bun:test";
import {
  AUTOMATION_EVENT_NAMES,
  AUTOMATION_PRESETS,
  type AutomationConfig,
  AutomationConfigSchema,
  AutomationModuleDefSchema,
  defineAutomation,
  expandPreset,
  isDefineAutomation,
  isModuleEnabledForItem,
  isValidAutomationEvent,
  parseAutomationOverrides,
} from "./automation";

describe("AutomationModuleDefSchema", () => {
  test("accepts valid module definition", () => {
    const result = AutomationModuleDefSchema.safeParse({
      source: "./.claude/automation/cleanup.ts",
      on: ["pr.merged"],
      enabled: true,
    });
    expect(result.success).toBe(true);
  });

  test("accepts multiple events", () => {
    const result = AutomationModuleDefSchema.safeParse({
      source: "./merge.ts",
      on: ["pr.label_added", "ci.finished"],
      enabled: false,
    });
    expect(result.success).toBe(true);
  });

  test("defaults enabled to true", () => {
    const result = AutomationModuleDefSchema.parse({
      source: "./bind.ts",
      on: ["pr.opened"],
    });
    expect(result.enabled).toBe(true);
  });

  test("rejects empty source", () => {
    const result = AutomationModuleDefSchema.safeParse({
      source: "",
      on: ["pr.merged"],
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty events array", () => {
    const result = AutomationModuleDefSchema.safeParse({
      source: "./foo.ts",
      on: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown event name", () => {
    const result = AutomationModuleDefSchema.safeParse({
      source: "./foo.ts",
      on: ["totally.bogus"],
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown keys (strict)", () => {
    const result = AutomationModuleDefSchema.safeParse({
      source: "./foo.ts",
      on: ["pr.merged"],
      enabled: true,
      bogus: "field",
    });
    expect(result.success).toBe(false);
  });
});

describe("AutomationConfigSchema", () => {
  test("accepts full config", () => {
    const result = AutomationConfigSchema.safeParse({
      preset: "semi-auto",
      modules: {
        cleanup: {
          source: "./cleanup.ts",
          on: ["pr.merged"],
          enabled: true,
        },
        merge: {
          source: "./merge.ts",
          on: ["ci.finished", "pr.label_added"],
          enabled: false,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("defaults preset to supervised and modules to empty", () => {
    const result = AutomationConfigSchema.parse({});
    expect(result.preset).toBe("supervised");
    expect(result.modules).toEqual({});
  });

  test("rejects invalid preset", () => {
    const result = AutomationConfigSchema.safeParse({
      preset: "yolo",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid module name (uppercase)", () => {
    const result = AutomationConfigSchema.safeParse({
      modules: {
        BadName: {
          source: "./x.ts",
          on: ["pr.merged"],
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("isValidAutomationEvent", () => {
  test("accepts all defined event names", () => {
    for (const name of AUTOMATION_EVENT_NAMES) {
      expect(isValidAutomationEvent(name)).toBe(true);
    }
  });

  test("rejects unknown events", () => {
    expect(isValidAutomationEvent("foo.bar")).toBe(false);
    expect(isValidAutomationEvent("")).toBe(false);
    expect(isValidAutomationEvent("heartbeat")).toBe(false);
  });
});

describe("expandPreset", () => {
  test("supervised returns empty defaults", () => {
    expect(expandPreset("supervised")).toEqual({});
  });

  test("semi-auto enables cleanup and bind", () => {
    const defaults = expandPreset("semi-auto");
    expect(defaults.cleanup).toBe(true);
    expect(defaults.bind).toBe(true);
    expect(defaults.merge).toBeUndefined();
  });

  test("autonomous enables all three", () => {
    const defaults = expandPreset("autonomous");
    expect(defaults.cleanup).toBe(true);
    expect(defaults.bind).toBe(true);
    expect(defaults.merge).toBe(true);
  });
});

describe("parseAutomationOverrides", () => {
  test("parses valid CSV", () => {
    const overrides = parseAutomationOverrides("merge=false,bind=true");
    expect(overrides.get("merge")).toBe(false);
    expect(overrides.get("bind")).toBe(true);
  });

  test("handles whitespace", () => {
    const overrides = parseAutomationOverrides(" merge = false , bind = true ");
    expect(overrides.get("merge")).toBe(false);
    expect(overrides.get("bind")).toBe(true);
  });

  test("returns empty map for null/undefined/empty", () => {
    expect(parseAutomationOverrides(null).size).toBe(0);
    expect(parseAutomationOverrides(undefined).size).toBe(0);
    expect(parseAutomationOverrides("").size).toBe(0);
  });

  test("skips malformed entries", () => {
    const overrides = parseAutomationOverrides("merge=false,garbage,=bad,also=maybe");
    expect(overrides.get("merge")).toBe(false);
    expect(overrides.size).toBe(1);
  });
});

describe("isModuleEnabledForItem", () => {
  test("uses module enabled state when no override", () => {
    expect(isModuleEnabledForItem("cleanup", true, "supervised", new Map())).toBe(true);
    expect(isModuleEnabledForItem("cleanup", false, "supervised", new Map())).toBe(false);
  });

  test("per-item override wins over module config", () => {
    const overrides = new Map([["cleanup", false]]);
    expect(isModuleEnabledForItem("cleanup", true, "supervised", overrides)).toBe(false);
  });

  test("per-item override can enable a disabled module", () => {
    const overrides = new Map([["merge", true]]);
    expect(isModuleEnabledForItem("merge", false, "supervised", overrides)).toBe(true);
  });
});

describe("defineAutomation", () => {
  test("returns the definition unchanged", () => {
    const def = defineAutomation({
      name: "test-module",
      events: ["pr.merged"],
      fn: async () => ({ action: "none", reason: "test" }),
    });
    expect(def.name).toBe("test-module");
    expect(def.events).toEqual(["pr.merged"]);
  });
});

describe("isDefineAutomation", () => {
  test("detects defineAutomation( sentinel", () => {
    expect(isDefineAutomation('import { defineAutomation } from "mcp-cli"; defineAutomation({')).toBe(true);
  });

  test("returns false for non-matching source", () => {
    expect(isDefineAutomation('import { defineAlias } from "mcp-cli";')).toBe(false);
  });
});

describe("manifest automation section", () => {
  test("manifest accepts automation section", async () => {
    const { validateManifest } = await import("./manifest");
    const raw = {
      version: 1,
      initial: "impl",
      phases: {
        impl: { source: "./impl.ts", next: ["done"] },
        done: { source: "./done.ts" },
      },
      automation: {
        preset: "semi-auto",
        modules: {
          cleanup: {
            source: "./.claude/automation/cleanup.ts",
            on: ["pr.merged"],
            enabled: true,
          },
        },
      },
    };
    const manifest = validateManifest(raw, "/test/.mcx.yaml");
    expect(manifest.automation).toBeDefined();
    expect(manifest.automation?.preset).toBe("semi-auto");
    expect(Object.keys(manifest.automation?.modules ?? {})).toEqual(["cleanup"]);
  });

  test("manifest works without automation section", async () => {
    const { validateManifest } = await import("./manifest");
    const raw = {
      version: 1,
      initial: "impl",
      phases: {
        impl: { source: "./impl.ts", next: ["done"] },
        done: { source: "./done.ts" },
      },
    };
    const manifest = validateManifest(raw, "/test/.mcx.yaml");
    expect(manifest.automation).toBeUndefined();
  });
});
