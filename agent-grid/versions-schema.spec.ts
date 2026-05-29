import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderSchema, VersionEntrySchema, VersionsGridSchema, validateVersionsGrid } from "./versions-schema";

describe("VersionEntrySchema", () => {
  test("accepts a minimal passing entry", () => {
    const result = VersionEntrySchema.safeParse({
      version: "2.1.119",
      outcome: "pass",
    });
    expect(result.success).toBe(true);
  });

  test("accepts a full passing entry", () => {
    const result = VersionEntrySchema.safeParse({
      version: "2.1.119",
      first_seen: "2026-05-23T21:24:15Z",
      last_tested: "2026-05-28T03:00:00Z",
      outcome: "pass",
      recording: "recordings/claude-2.1.119.ndjson",
      archive: "binaries/claude-2.1.119.tgz",
    });
    expect(result.success).toBe(true);
  });

  test("accepts a failing entry with failure_class", () => {
    const result = VersionEntrySchema.safeParse({
      version: "0.30.1",
      outcome: "fail",
      failure_class: "spawn-failed",
      reason: "Codex broken",
    });
    expect(result.success).toBe(true);
  });

  test("rejects fail outcome without failure_class", () => {
    const result = VersionEntrySchema.safeParse({
      version: "0.30.1",
      outcome: "fail",
    });
    expect(result.success).toBe(false);
  });

  test("rejects pass outcome with failure_class", () => {
    const result = VersionEntrySchema.safeParse({
      version: "2.1.119",
      outcome: "pass",
      failure_class: "spawn-failed",
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty version string", () => {
    const result = VersionEntrySchema.safeParse({
      version: "",
      outcome: "untested",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid outcome", () => {
    const result = VersionEntrySchema.safeParse({
      version: "1.0.0",
      outcome: "broken",
    });
    expect(result.success).toBe(false);
  });

  test("rejects malformed ISO 8601 date", () => {
    const result = VersionEntrySchema.safeParse({
      version: "1.0.0",
      outcome: "untested",
      first_seen: "2026-05-23",
    });
    expect(result.success).toBe(false);
  });

  test("accepts fail-wontfix with failure_class", () => {
    const result = VersionEntrySchema.safeParse({
      version: "0.30.1",
      outcome: "fail-wontfix",
      failure_class: "wontfix",
      reason: "known regression",
    });
    expect(result.success).toBe(true);
  });

  test("accepts flake with failure_class", () => {
    const result = VersionEntrySchema.safeParse({
      version: "2.3.0",
      outcome: "flake",
      failure_class: "flake",
    });
    expect(result.success).toBe(true);
  });

  test("accepts untested without failure_class", () => {
    const result = VersionEntrySchema.safeParse({
      version: "latest",
      outcome: "untested",
    });
    expect(result.success).toBe(true);
  });
});

describe("ProviderSchema", () => {
  test("accepts a full provider", () => {
    const result = ProviderSchema.safeParse({
      name: "claude",
      track: "patch",
      versions: [{ version: "2.1.119", outcome: "pass" }],
    });
    expect(result.success).toBe(true);
  });

  test("accepts a disabled provider with no versions", () => {
    const result = ProviderSchema.safeParse({
      name: "grok",
      track: "minor",
      enabled: false,
    });
    expect(result.success).toBe(true);
  });

  test("defaults enabled to true", () => {
    const result = ProviderSchema.safeParse({
      name: "claude",
      track: "patch",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
    }
  });

  test("rejects unknown provider name", () => {
    const result = ProviderSchema.safeParse({
      name: "unknown-provider",
      track: "patch",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid track value", () => {
    const result = ProviderSchema.safeParse({
      name: "claude",
      track: "weekly",
    });
    expect(result.success).toBe(false);
  });
});

describe("VersionsGridSchema", () => {
  test("rejects empty providers array", () => {
    const result = VersionsGridSchema.safeParse({ providers: [] });
    expect(result.success).toBe(false);
  });

  test("rejects missing providers", () => {
    const result = VersionsGridSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("validateVersionsGrid", () => {
  const makeTmpDir = () => {
    const dir = join(tmpdir(), `versions-schema-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  test("validates a correct grid", () => {
    const dir = makeTmpDir();
    const grid = {
      providers: [
        {
          name: "claude",
          track: "patch",
          versions: [{ version: "2.1.119", outcome: "pass" }],
        },
      ],
    };
    const result = validateVersionsGrid(grid, dir);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test("detects duplicate provider names", () => {
    const dir = makeTmpDir();
    const grid = {
      providers: [
        { name: "claude", track: "patch", versions: [{ version: "1.0.0", outcome: "pass" }] },
        { name: "claude", track: "minor", versions: [{ version: "2.0.0", outcome: "pass" }] },
      ],
    };
    const result = validateVersionsGrid(grid, dir);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("duplicate provider"))).toBe(true);
  });

  test("detects duplicate versions within a provider", () => {
    const dir = makeTmpDir();
    const grid = {
      providers: [
        {
          name: "claude",
          track: "patch",
          versions: [
            { version: "2.1.119", outcome: "pass" },
            { version: "2.1.119", outcome: "fail", failure_class: "runtime-broken" },
          ],
        },
      ],
    };
    const result = validateVersionsGrid(grid, dir);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("duplicate version"))).toBe(true);
  });

  test("detects dangling recording path", () => {
    const dir = makeTmpDir();
    const grid = {
      providers: [
        {
          name: "claude",
          track: "patch",
          versions: [
            {
              version: "2.1.119",
              outcome: "pass",
              recording: "recordings/nonexistent.ndjson",
            },
          ],
        },
      ],
    };
    const result = validateVersionsGrid(grid, dir);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("recording path does not exist"))).toBe(true);
  });

  test("detects dangling archive path", () => {
    const dir = makeTmpDir();
    const grid = {
      providers: [
        {
          name: "claude",
          track: "patch",
          versions: [
            {
              version: "2.1.119",
              outcome: "pass",
              archive: "binaries/nonexistent.tgz",
            },
          ],
        },
      ],
    };
    const result = validateVersionsGrid(grid, dir);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("archive path does not exist"))).toBe(true);
  });

  test("accepts existing archive path", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "binaries"), { recursive: true });
    writeFileSync(join(dir, "binaries", "test.tgz"), "fake");
    const grid = {
      providers: [
        {
          name: "claude",
          track: "patch",
          versions: [
            {
              version: "2.1.119",
              outcome: "pass",
              archive: "binaries/test.tgz",
            },
          ],
        },
      ],
    };
    const result = validateVersionsGrid(grid, dir);
    expect(result.ok).toBe(true);
  });

  test("flags disabled provider with versions", () => {
    const dir = makeTmpDir();
    const grid = {
      providers: [
        {
          name: "grok",
          track: "minor",
          enabled: false,
          versions: [{ version: "1.0.0", outcome: "untested" }],
        },
      ],
    };
    const result = validateVersionsGrid(grid, dir);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("disabled provider"))).toBe(true);
  });

  test("returns structural errors for invalid input", () => {
    const dir = makeTmpDir();
    const result = validateVersionsGrid({ providers: "not-an-array" }, dir);
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});
