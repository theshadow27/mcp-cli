import { describe, expect, it } from "bun:test";

import { parseFlags } from "./flags";
import type { FlagSpec } from "./flags";

const SPECS: Record<string, FlagSpec> = {
  output: { type: "string", alias: "o" },
  verbose: { type: "boolean", alias: "V" },
  count: { type: "number", alias: "n" },
  env: { type: "string", repeatable: true },
};

describe("parseFlags", () => {
  it("parses long boolean flags", () => {
    const r = parseFlags(["--verbose"], SPECS);
    expect(r.flags.verbose).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("parses short boolean aliases", () => {
    const r = parseFlags(["-V"], SPECS);
    expect(r.flags.verbose).toBe(true);
  });

  it("parses long string flags", () => {
    const r = parseFlags(["--output", "file.txt"], SPECS);
    expect(r.flags.output).toBe("file.txt");
    expect(r.errors).toEqual([]);
  });

  it("parses short string aliases", () => {
    const r = parseFlags(["-o", "file.txt"], SPECS);
    expect(r.flags.output).toBe("file.txt");
  });

  it("parses number flags", () => {
    const r = parseFlags(["--count", "42"], SPECS);
    expect(r.flags.count).toBe(42);
    expect(r.errors).toEqual([]);
  });

  it("parses short number aliases", () => {
    const r = parseFlags(["-n", "7"], SPECS);
    expect(r.flags.count).toBe(7);
  });

  it("parses --flag=value syntax", () => {
    const r = parseFlags(["--output=out.json"], SPECS);
    expect(r.flags.output).toBe("out.json");
    expect(r.errors).toEqual([]);
  });

  it("parses --flag=value for numbers", () => {
    const r = parseFlags(["--count=99"], SPECS);
    expect(r.flags.count).toBe(99);
  });

  it("collects repeatable flags", () => {
    const r = parseFlags(["--env", "A=1", "--env", "B=2"], SPECS);
    expect(r.flags.env).toEqual(["A=1", "B=2"]);
  });

  it("collects repeatable flags with = syntax", () => {
    const r = parseFlags(["--env=A=1", "--env=B=2"], SPECS);
    expect(r.flags.env).toEqual(["A=1", "B=2"]);
  });

  it("collects positionals", () => {
    const r = parseFlags(["foo", "bar"], SPECS);
    expect(r.positionals).toEqual(["foo", "bar"]);
    expect(r.errors).toEqual([]);
  });

  it("mixes flags and positionals", () => {
    const r = parseFlags(["--verbose", "file.txt", "--count", "3"], SPECS);
    expect(r.flags.verbose).toBe(true);
    expect(r.flags.count).toBe(3);
    expect(r.positionals).toEqual(["file.txt"]);
  });

  it("stops flag parsing at --", () => {
    const r = parseFlags(["--verbose", "--", "--output", "x"], SPECS);
    expect(r.flags.verbose).toBe(true);
    expect(r.flags.output).toBeUndefined();
    expect(r.positionals).toEqual(["--output", "x"]);
  });

  it("detects --help", () => {
    const r = parseFlags(["--help"], SPECS);
    expect(r.help).toBe(true);
  });

  it("detects -h", () => {
    const r = parseFlags(["-h"], SPECS);
    expect(r.help).toBe(true);
  });

  it("errors on missing value for string flag", () => {
    const r = parseFlags(["--output"], SPECS);
    expect(r.errors).toEqual(["--output requires a value"]);
  });

  it("errors on missing value for number flag", () => {
    const r = parseFlags(["--count"], SPECS);
    expect(r.errors).toEqual(["--count requires a value"]);
  });

  it("rejects -prefixed token as a value", () => {
    const r = parseFlags(["--output", "--verbose"], SPECS);
    expect(r.errors).toEqual(["--output requires a value"]);
    expect(r.flags.verbose).toBe(true);
  });

  it("rejects short-flag-looking token as a value", () => {
    const r = parseFlags(["-o", "-V"], SPECS);
    expect(r.errors).toEqual(["-o requires a value"]);
    expect(r.flags.verbose).toBe(true);
  });

  it("errors on non-numeric value for number flag", () => {
    const r = parseFlags(["--count", "abc"], SPECS);
    expect(r.errors).toEqual(['--count requires a numeric value, got "abc"']);
  });

  it("errors on non-numeric = value for number flag", () => {
    const r = parseFlags(["--count=abc"], SPECS);
    expect(r.errors).toEqual(['--count requires a numeric value, got "abc"']);
  });

  it("errors on unknown flags", () => {
    const r = parseFlags(["--unknown", "-x"], SPECS);
    expect(r.errors).toEqual(["unknown flag: --unknown", "unknown flag: -x"]);
  });

  it("errors on = value for boolean flag", () => {
    const r = parseFlags(["--verbose=true"], SPECS);
    expect(r.errors).toEqual(["--verbose is a boolean flag and does not accept a value"]);
  });

  it("handles empty argv", () => {
    const r = parseFlags([], SPECS);
    expect(r.flags).toEqual({ env: [] });
    expect(r.positionals).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.help).toBe(false);
  });

  it("handles empty specs", () => {
    const r = parseFlags(["foo", "--bar"], {});
    expect(r.positionals).toEqual(["foo"]);
    expect(r.errors).toEqual(["unknown flag: --bar"]);
  });

  it("collects multiple errors", () => {
    const r = parseFlags(["--output", "--count", "abc"], SPECS);
    expect(r.errors.length).toBe(2);
  });

  it("last value wins for non-repeatable flags", () => {
    const r = parseFlags(["--output", "first", "--output", "second"], SPECS);
    expect(r.flags.output).toBe("second");
  });

  it("initializes repeatable flags to empty array", () => {
    const r = parseFlags([], SPECS);
    expect(r.flags.env).toEqual([]);
  });

  it("throws if repeatable is set on a non-string type", () => {
    expect(() => parseFlags([], { count: { type: "number", repeatable: true } })).toThrow(
      'flag --count: repeatable is only supported for type "string"',
    );
  });
});
