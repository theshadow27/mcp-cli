import { describe, expect, test } from "bun:test";
import { MIN_AUTO_MODE_VERSION, resolvePermissionMode, supportsAutoMode } from "./permission-mode";

const CURRENT = "2.1.239";

describe("supportsAutoMode", () => {
  test("accepts the verified floor and anything above it", () => {
    expect(supportsAutoMode(MIN_AUTO_MODE_VERSION)).toBe(true);
    expect(supportsAutoMode(CURRENT)).toBe(true);
    expect(supportsAutoMode("2.2.0")).toBe(true);
    expect(supportsAutoMode("3.0.0")).toBe(true);
  });

  test("rejects versions below the floor", () => {
    expect(supportsAutoMode("2.1.236")).toBe(false);
    expect(supportsAutoMode("2.0.999")).toBe(false);
    expect(supportsAutoMode("1.9.9")).toBe(false);
  });

  test("rejects unknown or unparseable versions", () => {
    expect(supportsAutoMode(null)).toBe(false);
    expect(supportsAutoMode(undefined)).toBe(false);
    expect(supportsAutoMode("")).toBe(false);
    expect(supportsAutoMode("2.1")).toBe(false);
    expect(supportsAutoMode("not-a-version")).toBe(false);
  });
});

describe("resolvePermissionMode", () => {
  test("auto on a modern binary hands the gate to the child", () => {
    const r = resolvePermissionMode({ strategy: "auto", contained: false, claudeVersion: CURRENT });
    expect(r.mode).toBe("auto");
    expect(r.childGated).toBe(true);
    expect(r.downgradeReason).toBeUndefined();
  });

  // `rules` and `delegate` both need every tool call to round-trip to the
  // daemon; auto mode is precisely what takes that round-trip away, so neither
  // may ever resolve to it regardless of version or containment.
  test.each(["rules", "delegate"] as const)("%s keeps --permission-mode default", (strategy) => {
    for (const contained of [true, false]) {
      for (const claudeVersion of [CURRENT, "2.0.0", null]) {
        const r = resolvePermissionMode({ strategy, contained, claudeVersion });
        expect(r.mode).toBe("default");
        expect(r.childGated).toBe(false);
        expect(r.downgradeReason).toBeUndefined();
      }
    }
  });

  test("a worktree session keeps the daemon-side gate and says why", () => {
    const r = resolvePermissionMode({ strategy: "auto", contained: true, claudeVersion: CURRENT });
    expect(r.mode).toBe("default");
    expect(r.childGated).toBe(false);
    expect(r.downgradeReason).toContain("ContainmentGuard");
  });

  test("an unverified binary keeps the daemon-side gate and says why", () => {
    const r = resolvePermissionMode({ strategy: "auto", contained: false, claudeVersion: "2.1.100" });
    expect(r.mode).toBe("default");
    expect(r.childGated).toBe(false);
    expect(r.downgradeReason).toContain(MIN_AUTO_MODE_VERSION);
  });

  test("an unknown version keeps the daemon-side gate", () => {
    const r = resolvePermissionMode({ strategy: "auto", contained: false, claudeVersion: null });
    expect(r.mode).toBe("default");
    expect(r.childGated).toBe(false);
    expect(r.downgradeReason).toContain("unknown");
  });

  // childGated is what tells the router whether a can_use_tool arriving at the
  // daemon is expected. Getting these out of step would either rubber-stamp
  // requests the classifier declined, or deny a session whose gate is the
  // daemon's own router — so pin the pairing rather than the fields alone.
  test("childGated is true exactly when the child got auto mode", () => {
    const cases = [
      { strategy: "auto", contained: false, claudeVersion: CURRENT },
      { strategy: "auto", contained: true, claudeVersion: CURRENT },
      { strategy: "auto", contained: false, claudeVersion: null },
      { strategy: "rules", contained: false, claudeVersion: CURRENT },
      { strategy: "delegate", contained: true, claudeVersion: CURRENT },
    ] as const;
    for (const c of cases) {
      const r = resolvePermissionMode(c);
      expect(r.childGated).toBe(r.mode === "auto");
    }
  });
});
