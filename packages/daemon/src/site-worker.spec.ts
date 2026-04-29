import { describe, expect, test } from "bun:test";
import { parseSitesArg } from "./site-worker";

describe("parseSitesArg", () => {
  test("returns string array for valid non-empty dense array", () => {
    expect(parseSitesArg(["foo", "bar"])).toEqual(["foo", "bar"]);
    expect(parseSitesArg(["single"])).toEqual(["single"]);
  });

  test("rejects non-array values", () => {
    expect(typeof parseSitesArg(null)).toBe("string");
    expect(typeof parseSitesArg(undefined)).toBe("string");
    expect(typeof parseSitesArg("foo")).toBe("string");
    expect(typeof parseSitesArg(42)).toBe("string");
    expect(typeof parseSitesArg({})).toBe("string");
  });

  test("rejects empty array", () => {
    expect(typeof parseSitesArg([])).toBe("string");
  });

  test("rejects sparse arrays", () => {
    const sparse = new Array(2);
    expect(typeof parseSitesArg(sparse)).toBe("string");

    const sparseWithOneHole = Object.assign(new Array(3), { 0: "a", 2: "b" }) as unknown[];
    expect(typeof parseSitesArg(sparseWithOneHole)).toBe("string");
  });

  test("rejects sparse arrays with extra enumerable properties", () => {
    const sparse = new Array(3);
    sparse[0] = "a";
    // hole at index 1
    sparse[2] = "b";
    (sparse as unknown as Record<string, unknown>).foo = "padding";
    // Object.keys(sparse).length === 3 === sparse.length, but index 1 is a hole
    expect(typeof parseSitesArg(sparse)).toBe("string");
  });

  test("rejects arrays containing non-strings", () => {
    expect(typeof parseSitesArg([1, 2])).toBe("string");
    expect(typeof parseSitesArg(["ok", null])).toBe("string");
    expect(typeof parseSitesArg(["ok", 42])).toBe("string");
  });

  test("error message is descriptive", () => {
    const msg = parseSitesArg([]) as string;
    expect(msg).toContain("non-empty");
    expect(msg).toContain("sites");
  });
});
