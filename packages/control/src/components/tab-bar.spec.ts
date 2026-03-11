import { describe, expect, it } from "bun:test";
import { buildBadges } from "./tab-bar";

describe("buildBadges", () => {
  it("returns empty when all counts are zero", () => {
    const badges = buildBadges({ sessionCount: 0, pendingPermissionCount: 0, errorServerCount: 0 });
    expect(badges).toEqual({});
  });

  it("sets claude badge without color when no pending permissions", () => {
    const badges = buildBadges({ sessionCount: 3, pendingPermissionCount: 0, errorServerCount: 0 });
    expect(badges.claude).toEqual({ count: 3 });
  });

  it("sets claude badge with red color when pending permissions exist", () => {
    const badges = buildBadges({ sessionCount: 2, pendingPermissionCount: 1, errorServerCount: 0 });
    expect(badges.claude).toEqual({ count: 2, color: "red" });
  });

  it("sets servers badge with red color for error servers", () => {
    const badges = buildBadges({ sessionCount: 0, pendingPermissionCount: 0, errorServerCount: 2 });
    expect(badges.servers).toEqual({ count: 2, color: "red" });
  });

  it("sets mail badge with yellow color when unread mail exists", () => {
    const badges = buildBadges({ sessionCount: 0, pendingPermissionCount: 0, errorServerCount: 0, unreadMailCount: 5 });
    expect(badges.mail).toEqual({ count: 5, color: "yellow" });
  });

  it("does not set mail badge when unreadMailCount is zero", () => {
    const badges = buildBadges({ sessionCount: 0, pendingPermissionCount: 0, errorServerCount: 0, unreadMailCount: 0 });
    expect(badges.mail).toBeUndefined();
  });

  it("does not set mail badge when unreadMailCount is omitted", () => {
    const badges = buildBadges({ sessionCount: 0, pendingPermissionCount: 0, errorServerCount: 0 });
    expect(badges.mail).toBeUndefined();
  });

  it("sets all badges simultaneously", () => {
    const badges = buildBadges({ sessionCount: 1, pendingPermissionCount: 1, errorServerCount: 1, unreadMailCount: 3 });
    expect(badges.claude).toBeDefined();
    expect(badges.servers).toBeDefined();
    expect(badges.mail).toEqual({ count: 3, color: "yellow" });
  });
});
