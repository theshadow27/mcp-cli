import { describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { options } from "@mcp-cli/core";
import { testOptions } from "../../../../test/test-options";
import { ExitError } from "../test-helpers";
import { type ProfileCliDeps, claudeProfile } from "./claude-profile";

/** Must never appear in any output this command produces. */
const SECRET = "bedrock-bearer-token-4c1f9e2a-do-not-print";

interface Harness {
  out: string[];
  err: string[];
  info: string[];
  deps: ProfileCliDeps;
  all: () => string;
}

function harness(): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const info: string[] = [];
  const deps = {
    log: (...args: unknown[]) => out.push(args.map(String).join(" ")),
    printError: (msg: string) => err.push(msg),
    printInfo: (msg: string) => info.push(msg),
    exit: mock((code: number) => {
      throw new ExitError(code);
    }),
  } as unknown as ProfileCliDeps;
  return { out, err, info, deps, all: () => [...out, ...err, ...info].join("\n") };
}

function writeProfile(name: string, text: string, mode = 0o600): string {
  mkdirSync(options.PROFILES_DIR, { recursive: true, mode: 0o700 });
  const path = join(options.PROFILES_DIR, `${name}.env`);
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
}

describe("mcx claude profile ls", () => {
  test("lists profile names, and says where to put them when there are none", async () => {
    using _opts = testOptions();
    const h = harness();
    await claudeProfile(["ls"], h.deps);
    expect(h.info.join("\n")).toContain(options.PROFILES_DIR);

    writeProfile("bedrock", "AWS_REGION=us-east-1\n");
    writeProfile("staging", "AWS_REGION=us-east-1\n");
    const h2 = harness();
    await claudeProfile(["ls"], h2.deps);
    expect(h2.out).toEqual(["bedrock", "staging"]);
  });

  test("--json emits the directory and the names", async () => {
    using _opts = testOptions();
    writeProfile("bedrock", "AWS_REGION=us-east-1\n");
    const h = harness();
    await claudeProfile(["ls", "--json"], h.deps);
    expect(JSON.parse(h.out.join("\n"))).toEqual({ dir: options.PROFILES_DIR, profiles: ["bedrock"] });
  });
});

describe("mcx claude profile show", () => {
  test("prints variable NAMES and never a value, in either output mode", async () => {
    using _opts = testOptions();
    writeProfile("bedrock", `AWS_REGION=us-east-1\nAWS_BEARER_TOKEN_BEDROCK=${SECRET}\n`);

    const text = harness();
    await claudeProfile(["show", "bedrock"], text.deps);
    expect(text.out.join("\n")).toContain("AWS_BEARER_TOKEN_BEDROCK");
    expect(text.all()).not.toContain(SECRET);
    // us-east-1 is a value too — `show` is name-only, not "hide the scary ones".
    expect(text.all()).not.toContain("us-east-1");

    const json = harness();
    await claudeProfile(["show", "bedrock", "--json"], json.deps);
    expect(JSON.parse(json.out.join("\n")).keys).toEqual(["AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"]);
    expect(json.all()).not.toContain(SECRET);
  });

  test("warns about a group-readable file by path", async () => {
    using _opts = testOptions();
    const path = writeProfile("loose", `AWS_BEARER_TOKEN_BEDROCK=${SECRET}\n`, 0o644);
    const h = harness();
    await claudeProfile(["show", "loose"], h.deps);
    expect(h.err.join("\n")).toContain(`chmod 600 ${path}`);
    expect(h.all()).not.toContain(SECRET);
  });

  test("a missing profile exits 1 with the expected path", async () => {
    using _opts = testOptions();
    const h = harness();
    await expect(claudeProfile(["show", "nope"], h.deps)).rejects.toBeInstanceOf(ExitError);
    expect(h.err.join("\n")).toContain("not found");
  });

  test("a malformed profile exits 1 without echoing the offending line", async () => {
    using _opts = testOptions();
    writeProfile("broken", `AWS_REGION=us-east-1\n${SECRET}\n`);
    const h = harness();
    await expect(claudeProfile(["show", "broken"], h.deps)).rejects.toBeInstanceOf(ExitError);
    expect(h.err.join("\n")).toContain("broken.env:2");
    expect(h.all()).not.toContain(SECRET);
  });
});

describe("mcx claude profile import", () => {
  test("copies a source file to 0600 inside a 0700 directory and reports var count only", async () => {
    using opts = testOptions();
    const src = join(opts.dir, "claude_bedrock.sh");
    // A shell file the operator already sources: `export` prefixes, 0644.
    writeFileSync(src, `export CLAUDE_CODE_USE_BEDROCK=1\nexport AWS_BEARER_TOKEN_BEDROCK=${SECRET}\n`, {
      mode: 0o644,
    });

    const h = harness();
    await claudeProfile(["import", "bedrock", src], h.deps);

    const dest = join(options.PROFILES_DIR, "bedrock.env");
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(statSync(options.PROFILES_DIR).mode & 0o777).toBe(0o700);
    expect(h.info.join("\n")).toContain("2 vars");
    expect(h.all()).not.toContain(SECRET);
  });

  test("refuses to overwrite an existing profile", async () => {
    using opts = testOptions();
    writeProfile("bedrock", "AWS_REGION=us-east-1\n");
    const src = join(opts.dir, "src.env");
    writeFileSync(src, "B=2\n");
    const h = harness();
    await expect(claudeProfile(["import", "bedrock", src], h.deps)).rejects.toBeInstanceOf(ExitError);
    expect(h.err.join("\n")).toContain("already exists");
  });

  test("refuses a malformed source before writing anything", async () => {
    using opts = testOptions();
    const src = join(opts.dir, "bad.env");
    writeFileSync(src, `${SECRET}\n`);
    const h = harness();
    await expect(claudeProfile(["import", "bad", src], h.deps)).rejects.toBeInstanceOf(ExitError);
    expect(h.all()).not.toContain(SECRET);
    expect(() => statSync(join(options.PROFILES_DIR, "bad.env"))).toThrow();
  });

  test("rejects a traversing profile name", async () => {
    using opts = testOptions();
    const src = join(opts.dir, "src.env");
    writeFileSync(src, "AWS_REGION=us-east-1\n");
    const h = harness();
    await expect(claudeProfile(["import", "../escape", src], h.deps)).rejects.toBeInstanceOf(ExitError);
    expect(h.err.join("\n")).toContain("invalid profile name");
  });
});

describe("mcx claude profile — dispatch", () => {
  test("unknown subcommand exits 1 with guidance", async () => {
    using _opts = testOptions();
    const h = harness();
    await expect(claudeProfile(["frobnicate"], h.deps)).rejects.toBeInstanceOf(ExitError);
    expect(h.err.join("\n")).toContain("ls, show, import");
  });
});
