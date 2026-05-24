import { describe, expect, it } from "bun:test";

import type { FileMeta } from "./_engine/file-loader";
import { evaluateRule } from "./_engine/rule";
import rule from "./cli-surface-registered.rule";

function makeFile(relPath: string, content: string): FileMeta {
  return {
    path: relPath,
    relPath,
    content,
    pkg: relPath.split("/").slice(0, 2).join("/"),
    isTest: false,
  };
}

describe("cli-surface-registered cross-file", () => {
  it("finds SUBCOMMANDS in a separate completions.ts file", () => {
    const main = makeFile(
      "packages/command/src/main.ts",
      `switch (command) {
        case "ls": break;
        case "call": break;
        case "missing": break;
      }`,
    );
    const completions = makeFile(
      "packages/command/src/commands/completions.ts",
      `export const SUBCOMMANDS = ["ls", "call"] as const;`,
    );
    const files = new Map([
      [main.path, main],
      [completions.path, completions],
    ]);
    const violations = evaluateRule(rule, main, files);
    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toBe('case "missing"');
  });

  it("returns violations for all cases when SUBCOMMANDS is empty", () => {
    const main = makeFile(
      "packages/command/src/main.ts",
      `const SUBCOMMANDS = [] as const;
      switch (command) {
        case "ls": break;
      }`,
    );
    const files = new Map([[main.path, main]]);
    const violations = evaluateRule(rule, main, files);
    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toBe('case "ls"');
  });

  it("skips nested switches (only outer dispatch checked)", () => {
    // Inner switch uses the SAME discriminant (`command`) so the isNested
    // guard — not just the expression filter — is what prevents "kill" from
    // being checked against SUBCOMMANDS.
    const main = makeFile(
      "packages/command/src/main.ts",
      `const SUBCOMMANDS = ["serve"] as const;
      switch (command) {
        case "serve":
          switch (command) {
            case "kill": break;
          }
          break;
      }`,
    );
    const files = new Map([[main.path, main]]);
    const violations = evaluateRule(rule, main, files);
    expect(violations).toHaveLength(0);
  });

  it("does not fire on files other than main.ts", () => {
    const other = makeFile("packages/command/src/commands/agent.ts", `switch (sub) { case "spawn": break; }`);
    const files = new Map([[other.path, other]]);
    const violations = evaluateRule(rule, other, files);
    expect(violations).toHaveLength(0);
  });

  it("hard-errors when SUBCOMMANDS anchor is not found in any loaded file", () => {
    // No inline SUBCOMMANDS, no completions.ts in the file set.
    // The rule must fail loudly rather than silently pass.
    const main = makeFile(
      "packages/command/src/main.ts",
      `switch (command) {
        case "ls": break;
      }`,
    );
    const files = new Map([[main.path, main]]);
    const violations = evaluateRule(rule, main, files);
    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toContain("anchor not found");
  });

  it("does not flag switch inside a helper function (only switch (command) is the dispatch)", () => {
    // A helper function with its own switch must not produce false positives.
    const main = makeFile(
      "packages/command/src/main.ts",
      `const SUBCOMMANDS = ["ls"] as const;
      switch (command) {
        case "ls": break;
      }
      function resolveTransport(t: string) {
        switch (t) {
          case "stdio": break;
          case "http": break;
        }
      }`,
    );
    const files = new Map([[main.path, main]]);
    const violations = evaluateRule(rule, main, files);
    expect(violations).toHaveLength(0);
  });
});
