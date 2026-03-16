import { describe, expect, test } from "bun:test";
import {
  extractDryRunFlag,
  extractFullFlag,
  extractJqFlag,
  extractTimeoutFlag,
  extractVerboseFlag,
  parseEnvVar,
  parseScope,
  splitServerTool,
} from "./parse";

describe("splitServerTool", () => {
  test("splits server/tool into tuple", () => {
    expect(splitServerTool("atlassian/search")).toEqual(["atlassian", "search"]);
  });

  test("splits on first slash only", () => {
    expect(splitServerTool("server/tool/extra")).toEqual(["server", "tool/extra"]);
  });

  test("returns null for plain word (no slash)", () => {
    expect(splitServerTool("atlassian")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(splitServerTool("")).toBeNull();
  });

  test("returns null when slash is at start", () => {
    expect(splitServerTool("/tool")).toBeNull();
  });

  test("returns null when slash is at end", () => {
    expect(splitServerTool("server/")).toBeNull();
  });

  test("handles hyphenated names", () => {
    expect(splitServerTool("my-server/my-tool")).toEqual(["my-server", "my-tool"]);
  });
});

describe("parseScope", () => {
  test("returns valid scope value", () => {
    expect(parseScope("user", ["user", "project", "local"])).toBe("user");
    expect(parseScope("project", ["user", "project", "local"])).toBe("project");
    expect(parseScope("local", ["user", "project", "local"])).toBe("local");
  });

  test("works with restricted scope list", () => {
    expect(parseScope("user", ["user", "project"])).toBe("user");
    expect(parseScope("project", ["user", "project"])).toBe("project");
  });

  test("throws on invalid scope", () => {
    expect(() => parseScope("local", ["user", "project"])).toThrow('Invalid scope "local": must be user, project');
  });

  test("throws on empty string", () => {
    expect(() => parseScope("", ["user", "project"])).toThrow("Invalid scope");
  });
});

describe("parseEnvVar", () => {
  test("splits KEY=VALUE", () => {
    expect(parseEnvVar("API_KEY=abc123")).toEqual(["API_KEY", "abc123"]);
  });

  test("splits on first equals only", () => {
    expect(parseEnvVar("KEY=val=ue")).toEqual(["KEY", "val=ue"]);
  });

  test("handles empty value", () => {
    expect(parseEnvVar("KEY=")).toEqual(["KEY", ""]);
  });

  test("throws on missing equals", () => {
    expect(() => parseEnvVar("NOEQUALS")).toThrow('Invalid --env value "NOEQUALS": expected KEY=VALUE');
  });

  test("throws on empty string", () => {
    expect(() => parseEnvVar("")).toThrow("Invalid --env value");
  });
});

describe("extractFullFlag", () => {
  test("extracts --full flag", () => {
    expect(extractFullFlag(["server", "tool", "--full"])).toEqual({
      full: true,
      rest: ["server", "tool"],
    });
  });

  test("extracts -f flag", () => {
    expect(extractFullFlag(["-f", "server", "tool"])).toEqual({
      full: true,
      rest: ["server", "tool"],
    });
  });

  test("returns full=false when no flag present", () => {
    expect(extractFullFlag(["server", "tool"])).toEqual({
      full: false,
      rest: ["server", "tool"],
    });
  });

  test("returns full=false for empty args", () => {
    expect(extractFullFlag([])).toEqual({ full: false, rest: [] });
  });
});

describe("extractJqFlag", () => {
  test("extracts --jq with filter", () => {
    expect(extractJqFlag(["server", "tool", "--jq", ".[:5]"])).toEqual({
      jq: ".[:5]",
      rest: ["server", "tool"],
    });
  });

  test("extracts --jq at start of args", () => {
    expect(extractJqFlag(["--jq", ".name", "server", "tool"])).toEqual({
      jq: ".name",
      rest: ["server", "tool"],
    });
  });

  test("returns undefined when no --jq flag", () => {
    expect(extractJqFlag(["server", "tool"])).toEqual({
      jq: undefined,
      rest: ["server", "tool"],
    });
  });

  test("returns undefined for empty args", () => {
    expect(extractJqFlag([])).toEqual({ jq: undefined, rest: [] });
  });

  test("handles --jq at end without value (no value to consume)", () => {
    // --jq at the very end with no following arg → treated as regular arg
    expect(extractJqFlag(["server", "--jq"])).toEqual({
      jq: undefined,
      rest: ["server", "--jq"],
    });
  });

  test("handles complex jq filter with pipes", () => {
    expect(extractJqFlag(["server", "tool", "--jq", ".[] | {id, name}"])).toEqual({
      jq: ".[] | {id, name}",
      rest: ["server", "tool"],
    });
  });
});

describe("extractTimeoutFlag", () => {
  test("extracts --timeout <seconds> and converts to ms", () => {
    expect(extractTimeoutFlag(["--timeout", "30", "server", "tool"])).toEqual({
      timeoutMs: 30_000,
      rest: ["server", "tool"],
    });
  });

  test("extracts --timeout=<seconds> form", () => {
    expect(extractTimeoutFlag(["server", "--timeout=120", "tool"])).toEqual({
      timeoutMs: 120_000,
      rest: ["server", "tool"],
    });
  });

  test("returns undefined timeoutMs when flag absent", () => {
    expect(extractTimeoutFlag(["server", "tool"])).toEqual({
      timeoutMs: undefined,
      rest: ["server", "tool"],
    });
  });

  test("ignores --timeout with non-numeric value", () => {
    expect(extractTimeoutFlag(["--timeout", "abc"])).toEqual({
      timeoutMs: undefined,
      rest: ["--timeout", "abc"],
    });
  });

  test("ignores --timeout with zero value", () => {
    expect(extractTimeoutFlag(["--timeout", "0"])).toEqual({
      timeoutMs: undefined,
      rest: ["--timeout", "0"],
    });
  });
});

describe("extractVerboseFlag", () => {
  test("extracts --verbose flag", () => {
    expect(extractVerboseFlag(["call", "server", "tool", "--verbose"])).toEqual({
      verbose: true,
      rest: ["call", "server", "tool"],
    });
  });

  test("extracts -V flag", () => {
    expect(extractVerboseFlag(["-V", "ls"])).toEqual({
      verbose: true,
      rest: ["ls"],
    });
  });

  test("returns verbose=false when no flag present", () => {
    expect(extractVerboseFlag(["call", "server", "tool"])).toEqual({
      verbose: false,
      rest: ["call", "server", "tool"],
    });
  });

  test("returns verbose=false for empty args", () => {
    expect(extractVerboseFlag([])).toEqual({ verbose: false, rest: [] });
  });

  test("does not match -v (reserved for --version)", () => {
    expect(extractVerboseFlag(["-v"])).toEqual({ verbose: false, rest: ["-v"] });
  });
});

describe("extractDryRunFlag", () => {
  test("extracts --dry-run flag", () => {
    expect(extractDryRunFlag(["call", "server", "tool", "--dry-run"])).toEqual({
      dryRun: true,
      rest: ["call", "server", "tool"],
    });
  });

  test("does not match -n (reserved for other commands like logs, claude)", () => {
    expect(extractDryRunFlag(["-n", "call", "server", "tool"])).toEqual({
      dryRun: false,
      rest: ["-n", "call", "server", "tool"],
    });
  });

  test("returns dryRun=false when no flag present", () => {
    expect(extractDryRunFlag(["call", "server", "tool"])).toEqual({
      dryRun: false,
      rest: ["call", "server", "tool"],
    });
  });

  test("returns dryRun=false for empty args", () => {
    expect(extractDryRunFlag([])).toEqual({ dryRun: false, rest: [] });
  });
});
