import { describe, expect, test } from "bun:test";
import { isValidDomainName } from "./domain";
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

  /**
   * The split rule is still "last `@`" — the error names the local part it produced,
   * which is what pins it: splitting on the FIRST `@` would report `claude-a`, not
   * `claude-a@b`. The address is then rejected because that local part contains `@`
   * (see below); parse-then-reject keeps the refusal explicit rather than making it an
   * accident of where the string divided.
   */
  test("splits on the LAST @ — provable from the local part it reports", () => {
    expect(() => parseMailAddress("claude-a@b@phoenix")).toThrow(/local part "claude-a@b"/);
    expect(() => parseMailAddress("a@b@c@phoenix")).toThrow(/local part "a@b@c"/);
  });

  /**
   * #3038 RED 3. `evil@beta@alpha` sent from domain `alpha` split to local `evil@beta`
   * with `alpha` as the suffix, so a spoof check on the domain passed; it stored as a
   * bare-looking `evil@beta`, and the victim's reply re-parsed THAT as evil AT beta and
   * carried the body out of alpha — with neither party ever typing `user@domain`.
   *
   * The invariant is that a stored address re-parses to itself, and the total way to get
   * it is to forbid `@` in a local part.
   */
  test("rejects @ in the local part — a stored address must re-parse to itself", () => {
    for (const raw of ["evil@beta@alpha", "claude-a@b@phoenix", "a@b@c@phoenix"]) {
      expect(() => parseMailAddress(raw)).toThrow(/local part/);
    }
    // Every address that DOES parse round-trips exactly.
    for (const raw of ["orchestrator", "boss@clrg", "*@phoenix", "boss@_"]) {
      const parsed = parseMailAddress(raw);
      expect(formatMailAddress(parsed)).toBe(raw);
      expect(parseMailAddress(formatMailAddress(parsed))).toEqual(parsed);
    }
  });

  test("the reserved name addresses the unassigned partition", () => {
    expect(parseMailAddress("boss@_")).toEqual({ local: "boss", domain: "_" });
    // `_` is not a legal domain name, so `mcx domain add _` can never shadow it.
    expect(isValidDomainName("_")).toBe(false);
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
    for (const raw of ["orchestrator", "orchestrator@phoenix", "*@clrg", "boss@_"]) {
      expect(formatMailAddress(parseMailAddress(raw))).toBe(raw);
    }
  });
});
