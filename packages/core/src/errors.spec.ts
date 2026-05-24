import { describe, expect, it } from "bun:test";
import { getErrorCode, getErrorMessage } from "./errors";

describe("getErrorMessage", () => {
  it("extracts the message from an Error instance", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns a string directly", () => {
    expect(getErrorMessage("plain string error")).toBe("plain string error");
  });

  it("extracts message from a plain { message } object", () => {
    expect(getErrorMessage({ message: "plain object error" })).toBe("plain object error");
  });

  it("coerces unknown values via String()", () => {
    expect(getErrorMessage(42)).toBe("42");
    expect(getErrorMessage({ toString: () => "custom" })).toBe("custom");
  });

  it("handles null and undefined", () => {
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
  });

  it("works with Error subclasses", () => {
    class MyError extends Error {}
    expect(getErrorMessage(new MyError("sub"))).toBe("sub");
  });

  it("does not throw for null-prototype objects (Object.create(null))", () => {
    const bare = Object.create(null) as object;
    expect(() => getErrorMessage(bare)).not.toThrow();
    // Falls back to Object.prototype.toString tag
    expect(getErrorMessage(bare)).toBe("[object Object]");
  });

  it("does not throw when toString() itself throws", () => {
    const evil = {
      toString() {
        throw new Error("toString boom");
      },
    };
    expect(() => getErrorMessage(evil)).not.toThrow();
    expect(getErrorMessage(evil)).toBe("[object Object]");
  });

  it("does not throw when the message getter throws (Proxy / throwing getter)", () => {
    const evil = Object.defineProperty({}, "message", {
      get() {
        throw new Error("getter boom");
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => getErrorMessage(evil)).not.toThrow();
    // Falls through to String() or Object.prototype.toString fallback
    expect(typeof getErrorMessage(evil)).toBe("string");
  });
});

describe("getErrorCode", () => {
  it("returns the string code from an Error-like object", () => {
    const e = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
    expect(getErrorCode(e)).toBe("ECONNREFUSED");
  });

  it("returns the code from a plain object", () => {
    expect(getErrorCode({ code: "ERR_NOT_FOUND" })).toBe("ERR_NOT_FOUND");
  });

  it("returns undefined when code is absent", () => {
    expect(getErrorCode(new Error("no code"))).toBeUndefined();
    expect(getErrorCode({})).toBeUndefined();
  });

  it("returns a numeric code (e.g. IpcCallError uses number codes)", () => {
    expect(getErrorCode({ code: 42 })).toBe(42);
    expect(getErrorCode({ code: -1001 })).toBe(-1001);
  });

  it("returns undefined when code is neither string nor number", () => {
    expect(getErrorCode({ code: null })).toBeUndefined();
    expect(getErrorCode({ code: true })).toBeUndefined();
    expect(getErrorCode({ code: {} })).toBeUndefined();
  });

  it("handles null and undefined safely", () => {
    expect(getErrorCode(null)).toBeUndefined();
    expect(getErrorCode(undefined)).toBeUndefined();
  });

  it("does not throw when the code getter throws (Proxy / throwing getter)", () => {
    const evil = Object.defineProperty({}, "code", {
      get() {
        throw new Error("getter boom");
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => getErrorCode(evil)).not.toThrow();
    expect(getErrorCode(evil)).toBeUndefined();
  });

  it("does not throw when a Proxy has trap fires on 'code' in err", () => {
    const proxy = new Proxy(
      {},
      {
        has(_target, key) {
          if (key === "code") throw new Error("has trap boom");
          return false;
        },
      },
    );
    expect(() => getErrorCode(proxy)).not.toThrow();
    expect(getErrorCode(proxy)).toBeUndefined();
  });
});
