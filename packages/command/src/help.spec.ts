import { describe, expect, test } from "bun:test";
import { type CommandHelp, formatHelp, getHelp, hasHelpFlag, registerHelp } from "./help";

describe("hasHelpFlag", () => {
  test("detects --help", () => {
    expect(hasHelpFlag(["--timeout", "30", "--help"])).toBe(true);
  });

  test("detects -h", () => {
    expect(hasHelpFlag(["-h"])).toBe(true);
  });

  test("returns false when absent", () => {
    expect(hasHelpFlag(["--timeout", "30"])).toBe(false);
  });

  test("returns false for empty args", () => {
    expect(hasHelpFlag([])).toBe(false);
  });
});

describe("registerHelp / getHelp", () => {
  test("round-trips a help entry", () => {
    const entry: CommandHelp = {
      name: "mcx test",
      summary: "test command",
      usage: ["mcx test <arg>"],
    };
    registerHelp("__test_roundtrip", entry);
    expect(getHelp("__test_roundtrip")).toBe(entry);
  });

  test("returns undefined for unregistered key", () => {
    expect(getHelp("__nonexistent")).toBeUndefined();
  });
});

describe("formatHelp", () => {
  test("formats minimal entry (no options, no examples)", () => {
    const output = formatHelp({
      name: "mcx foo",
      summary: "do the thing",
      usage: ["mcx foo <arg>"],
    });
    expect(output).toContain("mcx foo — do the thing");
    expect(output).toContain("Usage:");
    expect(output).toContain("  mcx foo <arg>");
    expect(output).not.toContain("Options:");
    expect(output).not.toContain("Examples:");
  });

  test("formats entry with options", () => {
    const output = formatHelp({
      name: "mcx bar",
      summary: "bar things",
      usage: ["mcx bar [flags]"],
      options: [
        ["--verbose", "Enable verbose output"],
        ["--timeout <ms>", "Max wait time"],
      ],
    });
    expect(output).toContain("Options:");
    expect(output).toContain("--verbose");
    expect(output).toContain("Enable verbose output");
    expect(output).toContain("--timeout <ms>");
    expect(output).toContain("Max wait time");
  });

  test("formats entry with examples", () => {
    const output = formatHelp({
      name: "mcx baz",
      summary: "baz stuff",
      usage: ["mcx baz"],
      examples: ['mcx baz --flag "value"'],
    });
    expect(output).toContain("Examples:");
    expect(output).toContain('mcx baz --flag "value"');
  });

  test("aligns option columns", () => {
    const output = formatHelp({
      name: "mcx align",
      summary: "alignment test",
      usage: ["mcx align"],
      options: [
        ["-s", "short flag"],
        ["--very-long-flag <val>", "long flag"],
      ],
    });
    const lines = output.split("\n");
    const shortLine = lines.find((l) => l.includes("-s"));
    const longLine = lines.find((l) => l.includes("--very-long-flag"));
    expect(shortLine).toBeDefined();
    expect(longLine).toBeDefined();
    const shortDescIdx = shortLine?.indexOf("short flag") ?? -1;
    const longDescIdx = longLine?.indexOf("long flag") ?? -1;
    expect(shortDescIdx).toBe(longDescIdx);
  });
});

describe("claude subcommand help registry", () => {
  // Import side-effects register all entries
  test("all claude subcommands are registered", async () => {
    await import("./help-claude");
    const subcommands = [
      "spawn",
      "ls",
      "send",
      "bye",
      "interrupt",
      "log",
      "wait",
      "resume",
      "worktrees",
      "approve",
      "deny",
    ];
    for (const sub of subcommands) {
      const help = getHelp(`claude ${sub}`);
      expect(help).toBeDefined();
      expect(help?.name).toContain(sub);
      expect(help?.usage.length).toBeGreaterThan(0);
    }
  });

  test("unregistered subcommand returns undefined (fallthrough)", async () => {
    await import("./help-claude");
    expect(getHelp("claude bogus")).toBeUndefined();
    expect(getHelp("codex wait")).toBeUndefined();
  });

  test("spawn entry includes worktree auto-generate hint", async () => {
    await import("./help-claude");
    const help = getHelp("claude spawn");
    if (!help) throw new Error("expected claude spawn help to be registered");
    const formatted = formatHelp(help);
    expect(formatted).toContain("auto-generates name if omitted");
  });

  test("spawn entry includes allow glob hint", async () => {
    await import("./help-claude");
    const help = getHelp("claude spawn");
    if (!help) throw new Error("expected claude spawn help to be registered");
    const formatted = formatHelp(help);
    expect(formatted).toContain("mcp__grafana__*");
  });
});
