import { describe, expect, it } from "bun:test";
import { testRule } from "am-i-done";

import { loadScenario } from "./_spec-harness";
import rule, { appendixTypes, setLiteralValues } from "./agent-protocol-appendix-sync.rule";

describe("setLiteralValues", () => {
  it("extracts string members of a typed Set literal", () => {
    const src = `const X: ReadonlySet<string> = new Set<Foo["type"]>(["a", "b", "c"]);`;
    expect(setLiteralValues(src, "X")).toEqual(["a", "b", "c"]);
  });

  it("ignores spread elements, keeping only literals", () => {
    const src = `const X = new Set([...BASE, "extra"]);`;
    expect(setLiteralValues(src, "X")).toEqual(["extra"]);
  });

  it("returns [] for an absent const", () => {
    expect(setLiteralValues(`const Y = new Set(["a"]);`, "X")).toEqual([]);
  });

  it("returns [] when the const is not a Set", () => {
    expect(setLiteralValues(`const X = ["a", "b"];`, "X")).toEqual([]);
  });

  it("ignores literals in comments", () => {
    const src = `const X = new Set([\n  "a", // "b"\n  /* "c" */ "d",\n]);`;
    expect(setLiteralValues(src, "X")).toEqual(["a", "d"]);
  });
});

describe("appendixTypes", () => {
  const spec = [
    "### Worker → Daemon",
    "",
    "| Type | Providers | Section |",
    "|---|---|---|",
    "| `ready` | all | §3.1 |",
    "| `db:end` | all | §4.6 |",
    "",
    "### Bidirectional",
    "",
    "| `should-not-appear` | x |",
  ].join("\n");

  it("collects backtick-quoted types under the given heading only", () => {
    expect([...appendixTypes(spec, "Worker → Daemon")].sort()).toEqual(["db:end", "ready"]);
  });

  it("stops at the next heading", () => {
    expect(appendixTypes(spec, "Worker → Daemon").has("should-not-appear")).toBe(false);
  });

  it("returns empty for an unknown heading", () => {
    expect(appendixTypes(spec, "Nope").size).toBe(0);
  });
});

describe("check over its scenario fixtures", () => {
  for (const scenario of [
    "clean",
    "commented-out",
    "empty-base",
    "flagged",
    "flagged-control",
    "flagged-extension",
    "missing-spec",
  ]) {
    it(scenario, async () => {
      const { files, expected } = loadScenario(rule.id, scenario);
      const found = await testRule(rule, files);
      const counts = Object.fromEntries(Object.keys(expected).map((path) => [path, 0]));
      for (const f of found) counts[f.file] = (counts[f.file] ?? 0) + 1;
      expect(counts).toEqual(expected);
    });
  }
});
