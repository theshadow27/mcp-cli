import { describe, expect, test } from "bun:test";
import { DomainBindError, validateDomainSnapshot } from "./bind";

const valid = {
  id: 3,
  name: "phoenix",
  host: null,
  path: "/projects/phoenix",
  createdAt: "2026-08-22T00:00:00Z",
};

describe("validateDomainSnapshot", () => {
  test("accepts a well-formed local domain", () => {
    expect(validateDomainSnapshot(valid)).toEqual(valid);
  });

  test("refuses to bind a worker in this process to a remote domain", () => {
    // The damaging shape of "it works because both ends are in one process":
    // a worker on this box happily running another machine's project code
    // against a path that means something different here.
    expect(() => validateDomainSnapshot({ ...valid, host: "boxen0010" })).toThrow(DomainBindError);
    expect(() => validateDomainSnapshot({ ...valid, host: "boxen0010" })).toThrow(/cannot be served by a worker/);
  });

  test("rejects a missing or non-object payload", () => {
    for (const value of [undefined, null, 1, "phoenix", true]) {
      expect(() => validateDomainSnapshot(value)).toThrow(DomainBindError);
    }
  });

  test("rejects an id that is not a real domain id", () => {
    // 0 is the unassigned sentinel and has no domains row by design; a worker
    // bound to it would be serving "everything not yet domain-scoped".
    for (const id of [0, -1, 1.5, "3", null, undefined]) {
      expect(() => validateDomainSnapshot({ ...valid, id })).toThrow(/id must be a positive integer/);
    }
  });

  test("rejects a name that is not a valid domain name", () => {
    for (const name of ["", "has space", "has/slash", "-leading", 5, null]) {
      expect(() => validateDomainSnapshot({ ...valid, name })).toThrow(/not a valid domain name/);
    }
  });

  test("rejects a host that is neither a string nor null", () => {
    expect(() => validateDomainSnapshot({ ...valid, host: 5 })).toThrow(/host must be a string or null/);
    expect(() => validateDomainSnapshot({ ...valid, host: undefined })).toThrow(/host must be a string or null/);
  });

  test("rejects an empty or non-string path", () => {
    for (const path of ["", 5, null, undefined]) {
      expect(() => validateDomainSnapshot({ ...valid, path })).toThrow(/path must be a non-empty string/);
    }
  });

  test("rejects a non-string createdAt", () => {
    expect(() => validateDomainSnapshot({ ...valid, createdAt: 0 })).toThrow(/createdAt must be a string/);
  });

  test("returns only the declared fields — extra keys do not ride along", () => {
    const withExtra = { ...valid, secret: "do not forward", nested: { a: 1 } };
    expect(validateDomainSnapshot(withExtra)).toEqual(valid);
  });
});
