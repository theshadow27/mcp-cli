import { describe, expect, it } from "bun:test";

import type { FileMeta } from "./_engine/file-loader";
import { loadFiles } from "./_engine/file-loader";
import { evaluateRule, validateAnchors } from "./_engine/rule";
import rule, { appendixTypes, setLiteralValues } from "./agent-protocol-appendix-sync.rule";

const repoRoot = process.cwd();

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

describe("agent-protocol-appendix-sync rule", () => {
  it("passes on the real repo — spec Appendix A covers all code types", async () => {
    const files = await loadFiles({ repoRoot });
    validateAnchors(rule, files);
    const anchor = [...files.values()].find((f) => f.relPath === "packages/daemon/src/abstract-worker-server.ts");
    if (!anchor) throw new Error("anchor file not loaded");
    const violations = evaluateRule(rule, anchor, files);
    expect(violations).toEqual([]);
  });

  it("flags a code worker-event type that the spec Appendix A omits", () => {
    // Real anchor path (so the spec resolves from disk) but content with a
    // bogus extra type the real Appendix A cannot list.
    const anchor: FileMeta = {
      path: `${repoRoot}/packages/daemon/src/abstract-worker-server.ts`,
      relPath: "packages/daemon/src/abstract-worker-server.ts",
      content: `const BASE_WORKER_EVENT_TYPES = new Set<Foo["type"]>(["ready", "bogus:type"]);`,
      pkg: "packages/daemon",
      isTest: false,
    };
    const violations = evaluateRule(rule, anchor, new Map([[anchor.path, anchor]]));
    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toContain("bogus:type");
  });

  it("does not run on non-anchor files", async () => {
    const files = await loadFiles({ repoRoot });
    const other = [...files.values()].find((f) => f.relPath === "packages/daemon/src/claude-server.ts");
    if (!other) throw new Error("claude-server.ts not loaded");
    expect(evaluateRule(rule, other, files)).toEqual([]);
  });
});
