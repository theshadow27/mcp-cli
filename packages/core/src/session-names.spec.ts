import { describe, expect, it } from "bun:test";
import { SESSION_NAMES, generateSessionName } from "./session-names";

describe("SESSION_NAMES", () => {
  it("contains at least 20 names", () => {
    expect(SESSION_NAMES.length).toBeGreaterThanOrEqual(20);
  });

  it("has no duplicates", () => {
    const unique = new Set(SESSION_NAMES);
    expect(unique.size).toBe(SESSION_NAMES.length);
  });
});

describe("generateSessionName", () => {
  it("returns first name when none are in use", () => {
    const name = generateSessionName(new Set());
    expect(name).toBe("Alice");
  });

  it("skips names already in use", () => {
    const used = new Set(["Alice", "Bob"]);
    const name = generateSessionName(used);
    expect(name).toBe("Carol");
  });

  it("returns suffixed name when all base names are taken", () => {
    const used = new Set(SESSION_NAMES);
    const name = generateSessionName(used);
    expect(name).toBe("Alice-2");
  });

  it("returns suffixed name skipping used suffixed names", () => {
    const used = new Set([...SESSION_NAMES, "Alice-2"]);
    const name = generateSessionName(used);
    expect(name).toBe("Bob-2");
  });
});
