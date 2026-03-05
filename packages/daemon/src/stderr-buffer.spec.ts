import { describe, expect, test } from "bun:test";
import { StderrRingBuffer } from "./stderr-buffer";

describe("StderrRingBuffer", () => {
  test("push returns timestamped entry", () => {
    const buf = new StderrRingBuffer();
    const entry = buf.push("srv", "hello");
    expect(entry.line).toBe("hello");
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  test("getLines returns lines in chronological order", () => {
    const buf = new StderrRingBuffer();
    buf.push("srv", "line1");
    buf.push("srv", "line2");
    buf.push("srv", "line3");

    const lines = buf.getLines("srv");
    expect(lines).toHaveLength(3);
    expect(lines[0].line).toBe("line1");
    expect(lines[2].line).toBe("line3");
  });

  test("getLines with limit returns last N lines", () => {
    const buf = new StderrRingBuffer();
    buf.push("srv", "line1");
    buf.push("srv", "line2");
    buf.push("srv", "line3");

    const lines = buf.getLines("srv", 2);
    expect(lines).toHaveLength(2);
    expect(lines[0].line).toBe("line2");
    expect(lines[1].line).toBe("line3");
  });

  test("getLines returns empty for unknown server", () => {
    const buf = new StderrRingBuffer();
    expect(buf.getLines("nope")).toEqual([]);
  });

  test("evicts oldest entries when capacity exceeded", () => {
    const buf = new StderrRingBuffer(3);
    buf.push("srv", "a");
    buf.push("srv", "b");
    buf.push("srv", "c");
    buf.push("srv", "d");

    const lines = buf.getLines("srv");
    expect(lines).toHaveLength(3);
    expect(lines[0].line).toBe("b");
    expect(lines[2].line).toBe("d");
  });

  test("servers are isolated", () => {
    const buf = new StderrRingBuffer();
    buf.push("s1", "hello");
    buf.push("s2", "world");

    expect(buf.getLines("s1")).toHaveLength(1);
    expect(buf.getLines("s2")).toHaveLength(1);
    expect(buf.getLines("s1")[0].line).toBe("hello");
  });

  test("clear by server", () => {
    const buf = new StderrRingBuffer();
    buf.push("s1", "a");
    buf.push("s2", "b");
    buf.clear("s1");

    expect(buf.getLines("s1")).toEqual([]);
    expect(buf.getLines("s2")).toHaveLength(1);
  });

  test("clear all", () => {
    const buf = new StderrRingBuffer();
    buf.push("s1", "a");
    buf.push("s2", "b");
    buf.clear();

    expect(buf.getLines("s1")).toEqual([]);
    expect(buf.getLines("s2")).toEqual([]);
  });
});
