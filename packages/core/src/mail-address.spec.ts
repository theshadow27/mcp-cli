import { describe, expect, test } from "bun:test";
import { formatMailAddress, parseMailAddress } from "./mail-address";

describe("parseMailAddress", () => {
  test("a bare name has no domain — null means unqualified, not any-domain", () => {
    expect(parseMailAddress("orchestrator")).toEqual({ local: "orchestrator", domain: null });
    expect(parseMailAddress("*")).toEqual({ local: "*", domain: null });
  });

  test("user@domain splits into both halves", () => {
    expect(parseMailAddress("orchestrator@phoenix")).toEqual({ local: "orchestrator", domain: "phoenix" });
    expect(parseMailAddress("*@phoenix")).toEqual({ local: "*", domain: "phoenix" });
  });

  test("splits on the LAST @, so an @ in the local part survives", () => {
    expect(parseMailAddress("claude-a@b@phoenix")).toEqual({ local: "claude-a@b", domain: "phoenix" });
    expect(parseMailAddress("a@b@c@phoenix")).toEqual({ local: "a@b@c", domain: "phoenix" });
  });

  test("surrounding whitespace is trimmed", () => {
    expect(parseMailAddress("  boss@clrg  ")).toEqual({ local: "boss", domain: "clrg" });
  });

  test("refuses an empty address", () => {
    expect(() => parseMailAddress("")).toThrow(/empty/);
    expect(() => parseMailAddress("   ")).toThrow(/empty/);
  });

  test("refuses an empty local part", () => {
    expect(() => parseMailAddress("@phoenix")).toThrow(/empty local part/);
  });

  test("refuses a trailing @ rather than reading it as the local domain", () => {
    expect(() => parseMailAddress("orchestrator@")).toThrow(/empty domain/);
  });

  test("refuses a domain half that is not a legal domain name", () => {
    expect(() => parseMailAddress("boss@has space")).toThrow(/invalid domain/);
    expect(() => parseMailAddress("boss@-leading-hyphen")).toThrow(/invalid domain/);
    expect(() => parseMailAddress("boss@dots.not.allowed")).toThrow(/invalid domain/);
  });

  test("accepts the domain-name vocabulary domains.md pins", () => {
    expect(parseMailAddress("a@phoenix-octovalve").domain).toBe("phoenix-octovalve");
    expect(parseMailAddress("a@work_2").domain).toBe("work_2");
    expect(parseMailAddress("a@0").domain).toBe("0");
  });
});

describe("formatMailAddress", () => {
  test("round-trips both forms", () => {
    for (const raw of ["orchestrator", "orchestrator@phoenix", "claude-a@b@phoenix", "*@clrg"]) {
      expect(formatMailAddress(parseMailAddress(raw))).toBe(raw);
    }
  });
});
