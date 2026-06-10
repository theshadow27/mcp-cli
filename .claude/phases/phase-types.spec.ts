import { describe, expect, test } from "bun:test";
import { parsePrEditFlags } from "./phase-types";

describe("parsePrEditFlags", () => {
  test("parses --remove-label flags", () => {
    const result = parsePrEditFlags(["--remove-label", "qa:fail"]);
    expect(result).toEqual({ addLabels: [], removeLabels: ["qa:fail"] });
  });

  test("parses --add-label flags", () => {
    const result = parsePrEditFlags(["--add-label", "qa:pass"]);
    expect(result).toEqual({ addLabels: ["qa:pass"], removeLabels: [] });
  });

  test("parses mixed --add-label and --remove-label flags", () => {
    const result = parsePrEditFlags(["--add-label", "review:pass", "--remove-label", "review:changes"]);
    expect(result).toEqual({ addLabels: ["review:pass"], removeLabels: ["review:changes"] });
  });

  test("handles multiple labels of the same type", () => {
    const result = parsePrEditFlags(["--remove-label", "a", "--remove-label", "b"]);
    expect(result).toEqual({ addLabels: [], removeLabels: ["a", "b"] });
  });

  test("returns empty arrays for empty input", () => {
    const result = parsePrEditFlags([]);
    expect(result).toEqual({ addLabels: [], removeLabels: [] });
  });

  test("throws on unknown flag", () => {
    expect(() => parsePrEditFlags(["--title", "oops"])).toThrow("prEdit: unknown flag --title");
  });
});
