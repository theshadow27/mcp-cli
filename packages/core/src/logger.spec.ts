import { afterEach, describe, expect, mock, test } from "bun:test";
import { capturingLogger, consoleLogger, silentLogger } from "./logger";

describe("consoleLogger", () => {
  afterEach(() => mock.restore());

  test("error routes to console.error", () => {
    const spy = mock(() => {});
    console.error = spy;
    consoleLogger.error("boom");
    expect(spy).toHaveBeenCalledWith("boom");
  });

  test("warn routes to console.warn", () => {
    const spy = mock(() => {});
    console.warn = spy;
    consoleLogger.warn("careful");
    expect(spy).toHaveBeenCalledWith("careful");
  });

  test("info routes to console.info", () => {
    const spy = mock(() => {});
    console.info = spy;
    consoleLogger.info("fyi");
    expect(spy).toHaveBeenCalledWith("fyi");
  });

  test("debug routes to console.debug", () => {
    const spy = mock(() => {});
    console.debug = spy;
    consoleLogger.debug("verbose");
    expect(spy).toHaveBeenCalledWith("verbose");
  });
});

describe("silentLogger", () => {
  afterEach(() => mock.restore());

  test("does not call console.error", () => {
    const spy = mock(() => {});
    console.error = spy;
    silentLogger.error("should be swallowed");
    expect(spy).not.toHaveBeenCalled();
  });

  test("does not call console.warn", () => {
    const spy = mock(() => {});
    console.warn = spy;
    silentLogger.warn("should be swallowed");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("capturingLogger", () => {
  test("captures messages with level tags", () => {
    const { logger, messages } = capturingLogger();
    logger.error("err msg");
    logger.warn("warn msg");
    logger.info("info msg");
    logger.debug("debug msg");

    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ level: "error", args: ["err msg"] });
    expect(messages[1]).toEqual({ level: "warn", args: ["warn msg"] });
    expect(messages[2]).toEqual({ level: "info", args: ["info msg"] });
    expect(messages[3]).toEqual({ level: "debug", args: ["debug msg"] });
  });

  test("texts array contains string representations", () => {
    const { logger, texts } = capturingLogger();
    logger.error("something broke");
    logger.info("started");

    expect(texts).toEqual(["something broke", "started"]);
  });

  test("captures multiple args", () => {
    const { logger, messages } = capturingLogger();
    logger.error("prefix", { detail: 42 });
    expect(messages[0].args).toEqual(["prefix", { detail: 42 }]);
  });
});
