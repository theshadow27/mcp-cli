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

describe("cli-surface-registered: dispatch → SUBCOMMANDS", () => {
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

describe("cli-surface-registered: SUBCOMMANDS → dispatch", () => {
  it("flags orphaned SUBCOMMANDS entries with no dispatch case", () => {
    const main = makeFile(
      "packages/command/src/main.ts",
      `switch (command) {
        case "ls": break;
      }`,
    );
    const completions = makeFile(
      "packages/command/src/commands/completions.ts",
      `export const SUBCOMMANDS = ["ls", "orphaned"] as const;`,
    );
    const files = new Map([
      [main.path, main],
      [completions.path, completions],
    ]);
    const violations = evaluateRule(rule, completions, files);
    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toBe('SUBCOMMANDS entry "orphaned" has no dispatch case');
  });

  it("does not flag entries that are dispatched via pre-switch args[0] check", () => {
    const main = makeFile(
      "packages/command/src/main.ts",
      `if (args[0] === "help") { printUsage(); return; }
      switch (command) {
        case "ls": break;
      }`,
    );
    const completions = makeFile(
      "packages/command/src/commands/completions.ts",
      `export const SUBCOMMANDS = ["ls", "help"] as const;`,
    );
    const files = new Map([
      [main.path, main],
      [completions.path, completions],
    ]);
    const violations = evaluateRule(rule, completions, files);
    expect(violations).toHaveLength(0);
  });

  it("reports nothing when all SUBCOMMANDS have dispatch cases", () => {
    const main = makeFile(
      "packages/command/src/main.ts",
      `switch (command) {
        case "ls": break;
        case "call": break;
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
    const violations = evaluateRule(rule, completions, files);
    expect(violations).toHaveLength(0);
  });

  it("skips when main.ts is not in the file set", () => {
    const completions = makeFile(
      "packages/command/src/commands/completions.ts",
      `export const SUBCOMMANDS = ["ls", "orphaned"] as const;`,
    );
    const files = new Map([[completions.path, completions]]);
    const violations = evaluateRule(rule, completions, files);
    expect(violations).toHaveLength(0);
  });

  it("flags multiple orphaned entries", () => {
    const main = makeFile(
      "packages/command/src/main.ts",
      `switch (command) {
        case "ls": break;
      }`,
    );
    const completions = makeFile(
      "packages/command/src/commands/completions.ts",
      `export const SUBCOMMANDS = ["ls", "dead1", "dead2"] as const;`,
    );
    const files = new Map([
      [main.path, main],
      [completions.path, completions],
    ]);
    const violations = evaluateRule(rule, completions, files);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.snippet)).toEqual([
      'SUBCOMMANDS entry "dead1" has no dispatch case',
      'SUBCOMMANDS entry "dead2" has no dispatch case',
    ]);
  });

  it("does not flag pre-switch args[0] flag comparisons as dispatched commands", () => {
    const main = makeFile(
      "packages/command/src/main.ts",
      `if (args[0] === "--help") { printUsage(); return; }
      switch (command) {
        case "ls": break;
      }`,
    );
    const completions = makeFile(
      "packages/command/src/commands/completions.ts",
      `export const SUBCOMMANDS = ["ls"] as const;`,
    );
    const files = new Map([
      [main.path, main],
      [completions.path, completions],
    ]);
    const violations = evaluateRule(rule, completions, files);
    expect(violations).toHaveLength(0);
  });
});

describe("cli-surface-registered: flag ↔ KNOWN_FLAGS", () => {
  it("flags a parsed --flag missing from KNOWN_FLAGS", () => {
    const file = makeFile(
      "packages/command/src/commands/example.ts",
      `const KNOWN_FLAGS = new Set(["--verbose"]);
      function parseExampleArgs(args: string[]) {
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--verbose") {}
          else if (args[i] === "--quiet") {}
        }
      }`,
    );
    const files = new Map([[file.path, file]]);
    const violations = evaluateRule(rule, file, files);
    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toBe('flag "--quiet" parsed but not in KNOWN_FLAGS');
  });

  it("flags a KNOWN_FLAGS entry not parsed anywhere", () => {
    const file = makeFile(
      "packages/command/src/commands/example.ts",
      `const KNOWN_FLAGS = new Set(["--verbose", "--dead-flag"]);
      function parseExampleArgs(args: string[]) {
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--verbose") {}
        }
      }`,
    );
    const files = new Map([[file.path, file]]);
    const violations = evaluateRule(rule, file, files);
    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toBe('KNOWN_FLAGS entry "--dead-flag" not parsed anywhere');
  });

  it("reports nothing when flags and KNOWN_FLAGS are in sync", () => {
    const file = makeFile(
      "packages/command/src/commands/example.ts",
      `const KNOWN_FLAGS = new Set(["--sprint", "--since"]);
      const sprintIdx = args.indexOf("--sprint");
      const sinceIdx = args.indexOf("--since");`,
    );
    const files = new Map([[file.path, file]]);
    const violations = evaluateRule(rule, file, files);
    expect(violations).toHaveLength(0);
  });

  it("excludes --help from the flag set-difference", () => {
    const file = makeFile(
      "packages/command/src/commands/example.ts",
      `const KNOWN_FLAGS = new Set(["--verbose"]);
      if (args.includes("--help")) return;
      if (args[i] === "--verbose") {}`,
    );
    const files = new Map([[file.path, file]]);
    const violations = evaluateRule(rule, file, files);
    expect(violations).toHaveLength(0);
  });

  it("does not fire when file has no KNOWN_FLAGS", () => {
    const file = makeFile(
      "packages/command/src/commands/gc.ts",
      `function parseGcArgs(args: string[]) {
        if (args[i] === "--dry-run") {}
        else if (args[i] === "--branches-only") {}
      }`,
    );
    const files = new Map([[file.path, file]]);
    const violations = evaluateRule(rule, file, files);
    expect(violations).toHaveLength(0);
  });

  it("does not fire on files outside commands/", () => {
    const file = makeFile(
      "packages/command/src/main.ts",
      `const KNOWN_FLAGS = new Set(["--verbose"]);
      if (args[i] === "--quiet") {}`,
    );
    const completions = makeFile(
      "packages/command/src/commands/completions.ts",
      "export const SUBCOMMANDS = [] as const;",
    );
    const files = new Map([
      [file.path, file],
      [completions.path, completions],
    ]);
    const violations = evaluateRule(rule, file, files);
    // Only the dispatch→SUBCOMMANDS check fires on main.ts, not the flag check
    // (no switch cases → no violations from sub-check 1 either)
    expect(violations).toHaveLength(0);
  });

  it("detects flags via indexOf and includes calls", () => {
    const file = makeFile(
      "packages/command/src/commands/example.ts",
      `const KNOWN_FLAGS = new Set(["--sprint"]);
      const idx = args.indexOf("--sprint");
      if (args.includes("--since")) {}`,
    );
    const files = new Map([[file.path, file]]);
    const violations = evaluateRule(rule, file, files);
    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toBe('flag "--since" parsed but not in KNOWN_FLAGS');
  });

  it("detects both directions simultaneously", () => {
    const file = makeFile(
      "packages/command/src/commands/example.ts",
      `const KNOWN_FLAGS = new Set(["--keep", "--dead"]);
      if (args[i] === "--keep") {}
      if (args[i] === "--new") {}`,
    );
    const files = new Map([[file.path, file]]);
    const violations = evaluateRule(rule, file, files);
    expect(violations).toHaveLength(2);
    const snippets = violations.map((v) => v.snippet).sort();
    expect(snippets).toEqual([
      'KNOWN_FLAGS entry "--dead" not parsed anywhere',
      'flag "--new" parsed but not in KNOWN_FLAGS',
    ]);
  });

  it("handles KNOWN_FLAGS as plain array", () => {
    const file = makeFile(
      "packages/command/src/commands/example.ts",
      `const KNOWN_FLAGS = ["--verbose"];
      if (args[i] === "--verbose") {}
      if (args[i] === "--missing") {}`,
    );
    const files = new Map([[file.path, file]]);
    const violations = evaluateRule(rule, file, files);
    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toBe('flag "--missing" parsed but not in KNOWN_FLAGS');
  });

  it("handles KNOWN_FLAGS as const array", () => {
    const file = makeFile(
      "packages/command/src/commands/example.ts",
      `const KNOWN_FLAGS = ["--verbose"] as const;
      if (args[i] === "--verbose") {}`,
    );
    const files = new Map([[file.path, file]]);
    const violations = evaluateRule(rule, file, files);
    expect(violations).toHaveLength(0);
  });
});
