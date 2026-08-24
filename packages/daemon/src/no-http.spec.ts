import { describe, expect, test } from "bun:test";
import {
  type HttpCapableGlobal,
  HttpForbiddenError,
  HttpSealFailedError,
  SEALED_LISTENER_KEYS,
  isHttpSealed,
  sealNoHttp,
} from "./no-http";

/** A stand-in for the Bun global, so no test mutates the runner's own. */
function fakeBun(): HttpCapableGlobal {
  return {
    serve: () => "a server",
    listen: () => "a socket",
    udpSocket: () => "a udp socket",
  };
}

describe("sealNoHttp", () => {
  test("removes every listener entry point", () => {
    const target = fakeBun();
    expect(isHttpSealed(target)).toBe(false);

    sealNoHttp(target);

    expect(isHttpSealed(target)).toBe(true);
    for (const key of SEALED_LISTENER_KEYS) {
      const entry = (target as Record<string, unknown>)[key] as () => unknown;
      expect(() => entry()).toThrow(HttpForbiddenError);
    }
  });

  test("the refusal names the key and points at the console worker", () => {
    const target = fakeBun();
    sealNoHttp(target);
    expect(() => (target.serve as () => unknown)()).toThrow(/Bun\.serve is not available in a domain worker/);
    expect(() => (target.serve as () => unknown)()).toThrow(/console worker/);
  });

  test("is idempotent", () => {
    const target = fakeBun();
    sealNoHttp(target);
    const sealedServe = target.serve;
    sealNoHttp(target);
    expect(target.serve).toBe(sealedServe);
    expect(isHttpSealed(target)).toBe(true);
  });

  test("cannot be undone by assignment", () => {
    const target = fakeBun();
    sealNoHttp(target);
    // Non-writable and non-configurable: a later "just put it back" is a
    // TypeError in strict mode (all modules are strict), not a quiet reversal.
    expect(() => {
      (target as Record<string, unknown>).serve = () => "a server";
    }).toThrow(TypeError);
    expect(isHttpSealed(target)).toBe(true);
  });

  test("throws instead of pretending when a key cannot be sealed", () => {
    // A runtime that no longer permits the seal must fail the worker at startup.
    // The alternative is a domain worker that quietly *can* open a listener,
    // which is the exact condition this guard exists to make impossible.
    const stubborn: HttpCapableGlobal = {};
    Object.defineProperty(stubborn, "serve", {
      value: () => "a server",
      writable: false,
      configurable: false,
    });
    expect(() => sealNoHttp(stubborn)).toThrow(HttpSealFailedError);
    expect(isHttpSealed(stubborn)).toBe(false);
  });
});

describe("isHttpSealed", () => {
  test("false when only some entry points are sealed", () => {
    const target = fakeBun();
    Object.defineProperty(target, "serve", { value: () => "still open" });
    expect(isHttpSealed(target)).toBe(false);
  });

  test("a look-alike function does not count as sealed", () => {
    // Recognition is by identity marker, not by "it throws" — a project could
    // legitimately install its own throwing stub, and that is not this guard.
    const target: HttpCapableGlobal = {
      serve: () => {
        throw new Error("no http");
      },
      listen: () => {
        throw new Error("no http");
      },
      udpSocket: () => {
        throw new Error("no http");
      },
    };
    expect(isHttpSealed(target)).toBe(false);
  });
});

describe("the real Bun global", () => {
  test("exposes every entry point this guard seals", () => {
    // If a Bun upgrade renames or removes one of these, the guard silently
    // stops covering it. Fail here rather than in a domain worker holding a
    // socket open.
    const real = globalThis.Bun as unknown as Record<string, unknown>;
    for (const key of SEALED_LISTENER_KEYS) {
      expect(typeof real[key]).toBe("function");
    }
  });
});
