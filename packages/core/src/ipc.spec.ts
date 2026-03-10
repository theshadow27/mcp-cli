import { describe, expect, test } from "bun:test";
import { nextId } from "./ipc";

describe("nextId", () => {
  test("returns sequential IDs with r prefix", () => {
    const id1 = nextId();
    const id2 = nextId();
    const id3 = nextId();

    // IDs should match r<number> pattern
    expect(id1).toMatch(/^r\d+$/);
    expect(id2).toMatch(/^r\d+$/);
    expect(id3).toMatch(/^r\d+$/);

    // Each call should increment
    const num1 = Number.parseInt(id1.slice(1), 10);
    const num2 = Number.parseInt(id2.slice(1), 10);
    const num3 = Number.parseInt(id3.slice(1), 10);
    expect(num2).toBe(num1 + 1);
    expect(num3).toBe(num2 + 1);
  });
});
