import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RESERVED_SPAWN_ENV_KEYS,
  SPAWN_PROFILE_MAX_BYTES,
  SpawnProfileError,
  describeSpawnProfile,
  findManifestProfile,
  listSpawnProfiles,
  loadSpawnProfile,
  parseSpawnProfileEnv,
  resolveSpawnProfile,
  spawnProfilePath,
  validateSpawnProfileName,
} from "./spawn-profile";

/** A value that must never appear in any message, summary, or log line. */
const SECRET = "AKIAIOSFODNN7EXAMPLE-tail-do-not-print";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcx-profile-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeProfile(name: string, text: string, mode = 0o600): string {
  const path = join(dir, `${name}.env`);
  writeFileSync(path, text, { mode });
  return path;
}

// ── Precedence: the whole point of the exercise ──

describe("resolveSpawnProfile", () => {
  test("flag beats manifest beats config", () => {
    expect(resolveSpawnProfile({ flag: "a", manifest: "b", config: "c" })).toEqual({ name: "a", source: "flag" });
    expect(resolveSpawnProfile({ manifest: "b", config: "c" })).toEqual({ name: "b", source: "manifest" });
    expect(resolveSpawnProfile({ config: "c" })).toEqual({ name: "c", source: "config" });
    expect(resolveSpawnProfile({})).toEqual({ name: null, source: "none" });
  });

  test("every layer is skipped when absent, in order", () => {
    expect(resolveSpawnProfile({ flag: undefined, manifest: undefined, config: "c" })).toEqual({
      name: "c",
      source: "config",
    });
    expect(resolveSpawnProfile({ flag: undefined, manifest: "b", config: undefined })).toEqual({
      name: "b",
      source: "manifest",
    });
  });

  test("an explicit opt-out stops the search — a lower layer cannot resurrect a profile", () => {
    // `--no-profile` with a configured default is the escape hatch: one session
    // on the bare daemon env while everything else stays on the profile.
    expect(resolveSpawnProfile({ flag: null, manifest: "b", config: "c" })).toEqual({ name: null, source: "flag" });
    // A repo pinning `profile: null` overrides the machine-wide default.
    expect(resolveSpawnProfile({ manifest: null, config: "c" })).toEqual({ name: null, source: "manifest" });
  });

  test("empty and whitespace-only names are opt-outs, not profile names", () => {
    expect(resolveSpawnProfile({ flag: "", config: "c" })).toEqual({ name: null, source: "flag" });
    expect(resolveSpawnProfile({ flag: "   ", config: "c" })).toEqual({ name: null, source: "flag" });
  });

  test("names are trimmed (a trailing newline from a YAML scalar must not become a filename)", () => {
    expect(resolveSpawnProfile({ manifest: " bedrock\n" })).toEqual({ name: "bedrock", source: "manifest" });
  });

  test("is pure — it never throws, even on a name the loader would reject", () => {
    expect(resolveSpawnProfile({ flag: "../../etc/passwd" })).toEqual({
      name: "../../etc/passwd",
      source: "flag",
    });
  });
});

// ── Names ──

describe("profile names", () => {
  test("rejects path traversal and empty names", () => {
    for (const bad of ["../evil", "a/b", "", ".hidden", "-lead", "x".repeat(65)]) {
      expect(() => validateSpawnProfileName(bad)).toThrow(SpawnProfileError);
    }
  });

  test("accepts ordinary names and builds a path inside the profiles dir", () => {
    expect(spawnProfilePath("bedrock", "/p")).toBe("/p/bedrock.env");
    expect(spawnProfilePath("bedrock-us_2", "/p")).toBe("/p/bedrock-us_2.env");
  });
});

// ── Parsing ──

describe("parseSpawnProfileEnv", () => {
  test("parses KEY=VALUE, comments, blank lines, and an export prefix", () => {
    const env = parseSpawnProfileEnv(
      [
        "# bedrock",
        "",
        "CLAUDE_CODE_USE_BEDROCK=1",
        "  AWS_REGION = us-east-1  ",
        "export AWS_BEARER_TOKEN_BEDROCK=abc123",
        "ANTHROPIC_DEFAULT_OPUS_MODEL=us.anthropic.claude-opus-4-5-v1:0",
      ].join("\n"),
      "p.env",
    );
    expect(env).toEqual({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      AWS_BEARER_TOKEN_BEDROCK: "abc123",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "us.anthropic.claude-opus-4-5-v1:0",
    });
  });

  test("honours quotes: single literal, double with escapes, hash kept inside a value", () => {
    const env = parseSpawnProfileEnv(
      ["A='lit\\n'", 'B="two\\nlines"', "C=pass#word", "D=", "E=  spaced  "].join("\n"),
      "p.env",
    );
    expect(env.A).toBe("lit\\n");
    expect(env.B).toBe("two\nlines");
    // No inline-comment stripping: a `#` is a perfectly ordinary character in a secret.
    expect(env.C).toBe("pass#word");
    expect(env.D).toBe("");
    expect(env.E).toBe("spaced");
  });

  test("last duplicate wins", () => {
    expect(parseSpawnProfileEnv("A=1\nA=2", "p.env").A).toBe("2");
  });

  test("rejects reserved keys the daemon derives per-spawn", () => {
    for (const key of RESERVED_SPAWN_ENV_KEYS) {
      expect(() => parseSpawnProfileEnv(`${key}=x`, "p.env")).toThrow(SpawnProfileError);
    }
  });

  test("a malformed line reports the line NUMBER and never echoes its content", () => {
    // A wrapped credential is the realistic malformed line — the parser must not
    // print back the very bytes it refused.
    const text = `GOOD=1\n${SECRET}\n`;
    expect(() => parseSpawnProfileEnv(text, "p.env")).toThrow(SpawnProfileError);
    try {
      parseSpawnProfileEnv(text, "p.env");
      throw new Error("expected a throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("p.env:2");
      expect(message).not.toContain(SECRET);
    }
  });

  test("a line whose key half is secret-shaped is rejected without echoing the key", () => {
    const text = `${SECRET}=value\n`;
    try {
      parseSpawnProfileEnv(text, "p.env");
      throw new Error("expected a throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("p.env:1");
      expect(message).not.toContain(SECRET);
    }
  });
});

// ── Loading ──

describe("loadSpawnProfile", () => {
  test("loads values and reports a 0600 file as secure", () => {
    writeProfile("ok", `AWS_BEARER_TOKEN_BEDROCK=${SECRET}\n`);
    const profile = loadSpawnProfile("ok", dir);
    expect(profile.env.AWS_BEARER_TOKEN_BEDROCK).toBe(SECRET);
    expect(profile.insecureMode).toBe(false);
  });

  test("flags a group/world-readable file instead of silently using it", () => {
    writeProfile("loose", "A=1\n", 0o644);
    expect(loadSpawnProfile("loose", dir).insecureMode).toBe(true);
  });

  test("a missing profile throws and names the expected path", () => {
    expect(() => loadSpawnProfile("nope", dir)).toThrow(/not found/);
  });

  test("an oversized file is refused rather than read into memory", () => {
    writeProfile("huge", `A=${"x".repeat(SPAWN_PROFILE_MAX_BYTES + 1)}\n`);
    expect(() => loadSpawnProfile("huge", dir)).toThrow(/too large/);
  });

  test("describeSpawnProfile returns key names only — no value survives", () => {
    writeProfile("described", `AWS_BEARER_TOKEN_BEDROCK=${SECRET}\nAWS_REGION=us-east-1\n`);
    const summary = describeSpawnProfile(loadSpawnProfile("described", dir));
    expect(summary.keys).toEqual(["AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"]);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  test("listSpawnProfiles returns sorted names and tolerates a missing directory", () => {
    expect(listSpawnProfiles(join(dir, "does-not-exist"))).toEqual([]);
    const listDir = join(dir, "list");
    mkdirSync(listDir, { recursive: true });
    writeFileSync(join(listDir, "b.env"), "A=1\n");
    writeFileSync(join(listDir, "a.env"), "A=1\n");
    writeFileSync(join(listDir, "notes.txt"), "ignored\n");
    expect(listSpawnProfiles(listDir)).toEqual(["a", "b"]);
  });
});

// ── Manifest layer ──

describe("findManifestProfile", () => {
  test("reads `profile:` from a .mcx.yaml at or above the directory", () => {
    const root = join(dir, "repo");
    const nested = join(root, "packages", "thing");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, ".mcx.yaml"), "version: 1\nprofile: bedrock\ninitial: impl\nphases: {}\n");
    expect(findManifestProfile(root)).toBe("bedrock");
    expect(findManifestProfile(nested)).toBe("bedrock");
  });

  test("`profile: null` is an explicit opt-out, distinct from an absent key", () => {
    const nullRoot = join(dir, "repo-null");
    mkdirSync(nullRoot, { recursive: true });
    writeFileSync(join(nullRoot, ".mcx.yaml"), "version: 1\nprofile: null\ninitial: impl\nphases: {}\n");
    expect(findManifestProfile(nullRoot)).toBeNull();

    const bareRoot = join(dir, "repo-bare");
    mkdirSync(bareRoot, { recursive: true });
    writeFileSync(join(bareRoot, ".mcx.yaml"), "version: 1\ninitial: impl\nphases: {}\n");
    expect(findManifestProfile(bareRoot)).toBeUndefined();
  });

  test("a malformed manifest contributes nothing rather than breaking the spawn", () => {
    const broken = join(dir, "repo-broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, ".mcx.yaml"), ":\n  not: [valid\n");
    expect(findManifestProfile(broken)).toBeUndefined();
  });

  test("undefined cwd contributes nothing", () => {
    expect(findManifestProfile(undefined)).toBeUndefined();
  });
});
