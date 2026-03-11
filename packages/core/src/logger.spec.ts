import { describe, expect, test } from "bun:test";
import { consoleLogger, silentLogger } from "./logger";

describe("Logger", () => {
  test("consoleLogger has all methods", () => {
    expect(typeof consoleLogger.error).toBe("function");
    expect(typeof consoleLogger.warn).toBe("function");
    expect(typeof consoleLogger.info).toBe("function");
    expect(typeof consoleLogger.debug).toBe("function");
  });

  test("silentLogger has all methods", () => {
    expect(typeof silentLogger.error).toBe("function");
    expect(typeof silentLogger.warn).toBe("function");
    expect(typeof silentLogger.info).toBe("function");
    expect(typeof silentLogger.debug).toBe("function");
  });

  test("silentLogger methods are no-ops (do not throw)", () => {
    expect(() => silentLogger.error("test")).not.toThrow();
    expect(() => silentLogger.warn("test")).not.toThrow();
    expect(() => silentLogger.info("test")).not.toThrow();
    expect(() => silentLogger.debug("test")).not.toThrow();
  });
});
