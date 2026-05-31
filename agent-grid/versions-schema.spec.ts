import { describe, expect, test } from "bun:test";
import {
  ProviderSchema,
  VersionEntrySchema,
  VersionsGridSchema,
  hostPlatform,
  validateVersionsGrid,
} from "./versions-schema";

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

  test("accepts entry with platform field", () => {
    const result = VersionEntrySchema.safeParse({
      version: "2.1.119",
      outcome: "pass",
      platform: "darwin-arm64",
      archive: "binaries/claude-2.1.119.tgz",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.platform).toBe("darwin-arm64");
    }
  });

  test("accepts all valid platform values", () => {
    for (const p of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]) {
      const result = VersionEntrySchema.safeParse({
        version: "1.0.0",
        outcome: "pass",
        platform: p,
      });
      expect(result.success).toBe(true);
    }
  });

  test("rejects invalid platform value", () => {
    const result = VersionEntrySchema.safeParse({
      version: "1.0.0",
      outcome: "pass",
      platform: "windows-x64",
    });
    expect(result.success).toBe(false);
  });

  test("accepts entry without platform (platform-agnostic)", () => {
    const result = VersionEntrySchema.safeParse({
      version: "1.0.0",
      outcome: "pass",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.platform).toBeUndefined();
    }
  });

  test("rejects untested outcome with failure_class", () => {
    const result = VersionEntrySchema.safeParse({
      version: "latest",
      outcome: "untested",
      failure_class: "spawn-failed",
    });
    expect(result.success).toBe(false);
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
  test("validates a correct grid", () => {
    const grid = {
      providers: [
        {
          name: "claude",
          track: "patch",
          versions: [{ version: "2.1.119", outcome: "pass" }],
        },
      ],
    };
    const result = validateVersionsGrid(grid);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test("detects duplicate provider names", () => {
    const grid = {
      providers: [
        { name: "claude", track: "patch", versions: [{ version: "1.0.0", outcome: "pass" }] },
        { name: "claude", track: "minor", versions: [{ version: "2.0.0", outcome: "pass" }] },
      ],
    };
    const result = validateVersionsGrid(grid);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("duplicate provider"))).toBe(true);
  });

  test("detects duplicate versions within a provider (no platform)", () => {
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
    const result = validateVersionsGrid(grid);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("duplicate version"))).toBe(true);
  });

  test("allows same version with different platforms", () => {
    const grid = {
      providers: [
        {
          name: "claude",
          track: "patch",
          versions: [
            { version: "2.1.119", outcome: "pass", platform: "darwin-arm64", archive: "binaries/claude-2.1.119.tgz" },
            {
              version: "2.1.119",
              outcome: "untested",
              platform: "linux-x64",
              archive: "binaries/claude-2.1.119-linux-x64.tgz",
            },
          ],
        },
      ],
    };
    const result = validateVersionsGrid(grid);
    expect(result.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  test("detects duplicate version+platform pair", () => {
    const grid = {
      providers: [
        {
          name: "claude",
          track: "patch",
          versions: [
            { version: "2.1.119", outcome: "pass", platform: "darwin-arm64" },
            { version: "2.1.119", outcome: "fail", failure_class: "runtime-broken", platform: "darwin-arm64" },
          ],
        },
      ],
    };
    const result = validateVersionsGrid(grid);
    expect(result.ok).toBe(false);
    expect(
      result.issues.some((i) => i.message.includes("duplicate version") && i.message.includes("darwin-arm64")),
    ).toBe(true);
  });

  test("rejects recording path with traversal", () => {
    const grid = {
      providers: [
        {
          name: "claude",
          track: "patch",
          versions: [{ version: "2.1.119", outcome: "pass", recording: "../etc/passwd" }],
        },
      ],
    };
    const result = validateVersionsGrid(grid);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("relative within agent-grid"))).toBe(true);
  });

  test("rejects absolute archive path", () => {
    const grid = {
      providers: [
        {
          name: "claude",
          track: "patch",
          versions: [{ version: "2.1.119", outcome: "pass", archive: "/tmp/evil.tgz" }],
        },
      ],
    };
    const result = validateVersionsGrid(grid);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("relative within agent-grid"))).toBe(true);
  });

  test("accepts relative archive path", () => {
    const grid = {
      providers: [
        {
          name: "claude",
          track: "patch",
          versions: [{ version: "2.1.119", outcome: "pass", archive: "binaries/test.tgz" }],
        },
      ],
    };
    const result = validateVersionsGrid(grid);
    expect(result.ok).toBe(true);
  });

  test("warns on disabled provider with versions (non-blocking)", () => {
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
    const result = validateVersionsGrid(grid);
    expect(result.ok).toBe(true);
    expect(result.issues.some((i) => i.message.includes("disabled provider") && i.severity === "warn")).toBe(true);
  });

  test("returns structural errors for invalid input", () => {
    const result = validateVersionsGrid({ providers: "not-an-array" });
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe("hostPlatform", () => {
  test("returns a valid platform string on supported hosts, or null on unsupported ones", () => {
    const platform = hostPlatform();
    if (platform !== null) {
      expect(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]).toContain(platform);
    }
    // null is a valid return value on unsupported/unknown host platforms
  });
});
