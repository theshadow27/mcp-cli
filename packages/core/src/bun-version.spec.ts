import { describe, expect, it, spyOn } from "bun:test";
import { MIN_BUN_VERSION, assertBunVersion } from "./bun-version";

describe("assertBunVersion", () => {
  it("MIN_BUN_VERSION is 1.2.18", () => {
    expect(MIN_BUN_VERSION).toBe("1.2.18");
  });

  it("does not exit when current Bun version meets the minimum", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      // Current Bun version must be >= 1.2.18 for tests to run at all
      expect(() => assertBunVersion(MIN_BUN_VERSION)).not.toThrow();
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("exits 1 with a clear message when version is too old", () => {
    const messages: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((msg) => {
      messages.push(String(msg));
      return true;
    });
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    try {
      expect(() => assertBunVersion("999.0.0")).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(messages.join("")).toContain("requires Bun >=999.0.0");
      expect(messages.join("")).toContain("bun upgrade");
    } finally {
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("does not exit when minimum is a known-older Bun release", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      // Any currently-shipping Bun (>=1.2.18) should satisfy a >=1.2.0 requirement
      expect(() => assertBunVersion("1.2.0")).not.toThrow();
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
