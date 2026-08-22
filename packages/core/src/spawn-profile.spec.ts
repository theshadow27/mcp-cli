import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitRootResult } from "./git";
import {
  RESERVED_SPAWN_ENV_KEYS,
  SPAWN_PROFILE_ALLOWED_PREFIXES,
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
  test("flag beats config", () => {
    expect(resolveSpawnProfile({ flag: "a", config: "c" })).toEqual({ name: "a", source: "flag" });
    expect(resolveSpawnProfile({ config: "c" })).toEqual({ name: "c", source: "config" });
    expect(resolveSpawnProfile({})).toEqual({ name: null, source: "none" });
  });

  test("every layer is skipped when absent, in order", () => {
    expect(resolveSpawnProfile({ flag: undefined, manifest: undefined, config: "c" })).toEqual({
      name: "c",
      source: "config",
    });
  });

  test("an explicit opt-out stops the search — a lower layer cannot resurrect a profile", () => {
    // `--no-profile` with a configured default is the escape hatch: one session
    // on the bare daemon env while everything else stays on the profile.
    expect(resolveSpawnProfile({ flag: null, manifest: null, config: "c" })).toEqual({ name: null, source: "flag" });
    // A repo pinning `profile: null` overrides the machine-wide default. This is
    // the ONLY thing a repo file may do — see the manifest layer below.
    expect(resolveSpawnProfile({ manifest: null, config: "c" })).toEqual({ name: null, source: "manifest" });
  });

  test("empty and whitespace-only names are opt-outs, not profile names", () => {
    expect(resolveSpawnProfile({ flag: "", config: "c" })).toEqual({ name: null, source: "flag" });
    expect(resolveSpawnProfile({ flag: "   ", config: "c" })).toEqual({ name: null, source: "flag" });
  });

  test("names are trimmed (a trailing newline from a YAML scalar must not become a filename)", () => {
    expect(resolveSpawnProfile({ flag: " bedrock\n" })).toEqual({ name: "bedrock", source: "flag" });
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
      [
        "AWS_A='lit\\n'",
        'AWS_B="two\\nlines"',
        "AWS_C=pass#word",
        "AWS_D=",
        "AWS_E=  spaced  ",
        'AWS_F="has # hash"',
      ].join("\n"),
      "p.env",
    );
    expect(env.AWS_A).toBe("lit\\n");
    expect(env.AWS_B).toBe("two\nlines");
    // A `#` with no leading whitespace is an ordinary character in a secret.
    expect(env.AWS_C).toBe("pass#word");
    expect(env.AWS_D).toBe("");
    expect(env.AWS_E).toBe("spaced");
    expect(env.AWS_F).toBe("has # hash");
  });

  test("strips a whitespace-preceded inline comment, as bash and dotenv do", () => {
    // `source`-compatibility is the module's selling point. Keeping " # prod" in
    // a bearer token yields a 403 the operator cannot debug, because every
    // display path prints key names only, by design.
    const env = parseSpawnProfileEnv("AWS_REGION=us-east-1 # prod\nAWS_TOKEN='abc' # note\n", "p.env");
    expect(env.AWS_REGION).toBe("us-east-1");
    expect(env.AWS_TOKEN).toBe("abc");
  });

  test("last duplicate wins", () => {
    expect(parseSpawnProfileEnv("AWS_A=1\nAWS_A=2", "p.env").AWS_A).toBe("2");
  });

  test("a bare KEY line means UNSET, not empty string", () => {
    // The daemon merges { ...process.env, ...profile }, so "" would leave a
    // second live credential in the child. A Bedrock profile must be able to
    // remove the subscription token it inherited, not blank it.
    const env = parseSpawnProfileEnv(
      "CLAUDE_CODE_USE_BEDROCK=1\nANTHROPIC_API_KEY\nexport ANTHROPIC_AUTH_TOKEN # drop\n",
      "p.env",
    );
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect("ANTHROPIC_API_KEY" in env).toBe(true);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect("ANTHROPIC_AUTH_TOKEN" in env).toBe(true);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test("rejects reserved keys the daemon derives per-spawn", () => {
    for (const key of RESERVED_SPAWN_ENV_KEYS) {
      expect(() => parseSpawnProfileEnv(`${key}=x`, "p.env")).toThrow(SpawnProfileError);
    }
  });

  test("refuses every variable outside the allowlist, including the code-execution ones", () => {
    // A profile is injected into an auto-approving agent's env, and (before the
    // deselect-only rule) a checked-in .mcx.yaml could choose which profile that
    // was. These are not configuration:
    //   LD_PRELOAD / NODE_OPTIONS / PATH / GIT_SSH_COMMAND → arbitrary code
    //   MCP_CLI_DIR  → reattaches the child's mcx to a different daemon + state DB
    //   HOME         → moves ~/.claude.json, ~/.aws, credential helpers
    for (const key of [
      "PATH",
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "HOME",
      "GIT_SSH_COMMAND",
      "GIT_CONFIG_GLOBAL",
      "MCP_CLI_DIR",
      "HTTPS_PROXY",
      "SHELL",
    ]) {
      expect(() => parseSpawnProfileEnv(`${key}=/tmp/x`, "p.env")).toThrow(SpawnProfileError);
      // An unset directive must not be a way around the allowlist either.
      expect(() => parseSpawnProfileEnv(key, "p.env")).toThrow(SpawnProfileError);
    }
  });

  test("allows the variables the feature exists for", () => {
    // Including ANTHROPIC_BASE_URL: redirecting the endpoint IS the feature
    // (#935 is the Bedrock quota escape hatch). It is safe to allow precisely
    // because only the operator — never repo content — chooses the profile.
    const env = parseSpawnProfileEnv(
      [
        "ANTHROPIC_BASE_URL=https://example.invalid",
        "CLOUD_ML_REGION=us-east5",
        "VERTEX_REGION_CLAUDE_4_5_SONNET=us-east5",
      ].join("\n"),
      "p.env",
    );
    expect(env.ANTHROPIC_BASE_URL).toBe("https://example.invalid");
    expect(env.CLOUD_ML_REGION).toBe("us-east5");
    for (const prefix of SPAWN_PROFILE_ALLOWED_PREFIXES) {
      expect(() => parseSpawnProfileEnv(`${prefix}THING=1`, "p.env")).not.toThrow();
    }
  });

  test("a malformed line reports the line NUMBER and never echoes its content", () => {
    // A wrapped credential is the realistic malformed line — the parser must not
    // print back the very bytes it refused.
    const text = `AWS_GOOD=1\n${SECRET}\n`;
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

  test("PROPERTY: no fragment of a wrapped secret is ever promoted to a key name", () => {
    // This is the assertion the original test only appeared to make. It used a
    // HYPHENATED fixture, so ENV_KEY_RE rejected it for an incidental reason and
    // the real hole stayed open: base64 padding ends in "=", so a continuation
    // line of a PEM key, a JWT or a GCP service-account blob parses as KEY=VALUE
    // and the "key" — secret material — is logged to ~/.mcp-cli/mcpd.log and
    // printed by `mcx claude profile show`.
    //
    // Assert the property (a secret fragment never becomes a key, and never
    // appears in the error) over every wrapping shape, not one fixture.
    const B64 = "ZGhpc2lzYXNlY3JldHRva2VuMTIzNDU2Nzg5MA==";
    const cases = [
      // Quoted value continued onto the next line — the reviewer's repro.
      `AWS_SECRET_ACCESS_KEY="MIIEvQIBADANBgkqhkiG9w0\n${B64}\nAWS_REGION=us-east-1`,
      // Unquoted wrap.
      `AWS_SECRET_ACCESS_KEY=MIIEvQIBADANBgkqhkiG9w0\n${B64}\n`,
      // A lone continuation fragment.
      `${B64}\n`,
      // Single-quoted wrap.
      `AWS_SECRET_ACCESS_KEY='MIIEvQIBADANBgkqhkiG9w0\n${B64}\n`,
    ];
    for (const text of cases) {
      let parsed: Record<string, string | undefined> | null = null;
      let message = "";
      try {
        parsed = parseSpawnProfileEnv(text, "p.env");
      } catch (err) {
        // Any refusal must be a SpawnProfileError: those messages are value-free
        // by construction, an arbitrary error's are not.
        expect(err).toBeInstanceOf(SpawnProfileError);
        message = (err as Error).message;
      }
      // Either it threw, or it parsed — but the fragment must never surface as a
      // key, and the message that refused it must never echo the fragment.
      expect(Object.keys(parsed ?? {})).not.toContain(B64);
      expect(message).not.toContain(B64);
      expect(message).not.toContain("MIIEvQIBADANBgkqhkiG9w0");
      // And no key may carry a fragment of it either.
      for (const key of Object.keys(parsed ?? {})) {
        expect(B64).not.toContain(key);
      }
    }
  });

  test("an unterminated quoted value is refused rather than silently truncated", () => {
    // Truncation is the other half of the same bug: without this the value
    // becomes '"MIIEvQIBADANBgkqhkiG9w0 and the spawn runs on half a credential.
    for (const text of ['AWS_SECRET_ACCESS_KEY="abc', "AWS_SECRET_ACCESS_KEY='abc", 'AWS_SECRET_ACCESS_KEY="abc\\"']) {
      expect(() => parseSpawnProfileEnv(text, "p.env")).toThrow(/p\.env:1/);
      expect(() => parseSpawnProfileEnv(text, "p.env")).toThrow(SpawnProfileError);
    }
    // ...and text after the closing quote is a mistake, not a value.
    expect(() => parseSpawnProfileEnv('AWS_REGION="us-east-1" oops', "p.env")).toThrow(/p\.env:1/);
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
    writeProfile("loose", "AWS_REGION=us-east-1\n", 0o644);
    expect(loadSpawnProfile("loose", dir).insecureMode).toBe(true);
  });

  test("a missing profile throws and names the expected path", () => {
    expect(() => loadSpawnProfile("nope", dir)).toThrow(/not found/);
  });

  test("an oversized file is refused rather than read into memory", () => {
    writeProfile("huge", `AWS_A=${"x".repeat(SPAWN_PROFILE_MAX_BYTES + 1)}\n`);
    expect(() => loadSpawnProfile("huge", dir)).toThrow(/too large/);
  });

  test("an empty or comments-only file is refused instead of reporting success", () => {
    // It used to load as {} and log `using profile "bedrock" (0 vars: )` while
    // the child ran bare — the silent fallback wearing a success message. A
    // `touch`, a truncated write or a half-finished edit all produce this.
    writeProfile("blank", "");
    expect(() => loadSpawnProfile("blank", dir)).toThrow(/defines no variables/);
    writeProfile("comments", "# TODO: fill this in\n\n");
    expect(() => loadSpawnProfile("comments", dir)).toThrow(/defines no variables/);
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
    writeFileSync(join(listDir, "b.env"), "AWS_A=1\n");
    writeFileSync(join(listDir, "a.env"), "AWS_A=1\n");
    writeFileSync(join(listDir, "notes.txt"), "ignored\n");
    // A directory named `prod.env` must not be offered as a profile: it would
    // pass the CLI pre-check and then fail at spawn, after a session teardown.
    mkdirSync(join(listDir, "prod.env"), { recursive: true });
    expect(listSpawnProfiles(listDir)).toEqual(["a", "b"]);
  });
});

// ── Manifest layer: deselect-only, and bounded by the checkout ──

/**
 * A repo whose root is pinned by injection rather than by a live `git rev-parse`.
 *
 * The real bound IS `findWorktreeRootResult`, but that shells out, and on a
 * saturated box fork() fails in milliseconds — which made these tests flake and,
 * worse, made the production path drop the layer. Production now warns on that;
 * the tests pin the boundary logic deterministically.
 */
function makeRepo(name: string): string {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  return root;
}

/** Pin `root` as the working-tree root for anything at or under it. */
function rootedAt(root: string): (d: string) => GitRootResult {
  return (d) => (d === root || d.startsWith(`${root}/`) ? { kind: "root", path: root } : { kind: "not-a-repo" });
}

const NO_REPO = (): GitRootResult => ({ kind: "not-a-repo" });

describe("findManifestProfile", () => {
  test("`profile: null` is honoured — a repo may opt OUT", () => {
    const root = makeRepo("repo-null");
    writeFileSync(join(root, ".mcx.yaml"), "version: 1\nprofile: null\ninitial: impl\nphases: {}\n");
    expect(findManifestProfile(root, undefined, rootedAt(root))).toBeNull();

    const bare = makeRepo("repo-bare");
    writeFileSync(join(bare, ".mcx.yaml"), "version: 1\ninitial: impl\nphases: {}\n");
    expect(findManifestProfile(bare, undefined, rootedAt(bare))).toBeUndefined();
  });

  test("finds the manifest from a nested directory, bounded by the checkout", () => {
    const root = makeRepo("repo-nested");
    const nested = join(root, "packages", "thing");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, ".mcx.yaml"), "version: 1\nprofile: null\ninitial: impl\nphases: {}\n");
    expect(findManifestProfile(nested, undefined, rootedAt(root))).toBeNull();
  });

  test("a NAMED profile is ignored — repo content may not select credentials", () => {
    // docs/trust.md: rules from an untrusted source are ignored, not merged. A
    // .mcx.yaml arrives by `git clone`, so honouring `profile: evil` would let a
    // third-party checkout choose which credentials an auto-approving agent
    // spawns with (and, via ANTHROPIC_BASE_URL, where they get sent).
    const root = makeRepo("repo-named");
    writeFileSync(join(root, ".mcx.yaml"), "version: 1\nprofile: bedrock\ninitial: impl\nphases: {}\n");
    const warnings: string[] = [];
    expect(findManifestProfile(root, (m) => warnings.push(m), rootedAt(root))).toBeUndefined();
    // Ignored LOUDLY: a silently dropped setting is how the next reader concludes
    // the feature is broken and "fixes" it back into a selector.
    expect(warnings.join("\n")).toContain("bedrock");
    expect(warnings.join("\n")).toContain(join(root, ".mcx.yaml"));
    expect(warnings.join("\n")).toContain("only opt OUT");
  });

  test("the ascent stops at the checkout root", () => {
    // Before this bound the walk ran 16 levels toward `/`, so a stray ~/.mcx.yaml
    // answered for every spawn on the box and a clone under ~/github/ inherited
    // its parent's answer.
    const outer = join(dir, "outer");
    const inner = join(outer, "inner-repo");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(outer, ".mcx.yaml"), "version: 1\nprofile: null\ninitial: impl\nphases: {}\n");
    // The outer manifest is above the repo root — out of scope, not inherited.
    expect(findManifestProfile(inner, undefined, rootedAt(inner))).toBeUndefined();
  });

  test("outside a git checkout only the directory itself is consulted", () => {
    const loose = join(dir, "loose", "sub");
    mkdirSync(loose, { recursive: true });
    writeFileSync(join(dir, "loose", ".mcx.yaml"), "version: 1\nprofile: null\ninitial: impl\nphases: {}\n");
    expect(findManifestProfile(loose, undefined, NO_REPO)).toBeUndefined();
  });

  test("every fall-open path warns, naming the file", () => {
    // Each of these used to drop the layer in total silence, so a tab-indent slip
    // nowhere near `profile:` moved a session onto different credentials with no
    // diagnostic anywhere.
    const broken = makeRepo("repo-broken");
    const brokenPath = join(broken, ".mcx.yaml");
    writeFileSync(brokenPath, ":\n  not: [valid\n");
    let warnings: string[] = [];
    expect(findManifestProfile(broken, (m) => warnings.push(m), rootedAt(broken))).toBeUndefined();
    expect(warnings.join("\n")).toContain(brokenPath);

    // `profile: yes` is a YAML boolean; `profile: [x]` a list. ManifestSchema
    // (z.string().min(1)) rejects both, but the schema is never applied here —
    // so two validators must not quietly give two answers.
    for (const [name, body] of [
      ["repo-bool", "profile: yes"],
      ["repo-list", "profile: [x]"],
      ["repo-empty", 'profile: ""'],
    ] as const) {
      const repo = makeRepo(name);
      writeFileSync(join(repo, ".mcx.yaml"), `version: 1\n${body}\ninitial: impl\nphases: {}\n`);
      warnings = [];
      expect(findManifestProfile(repo, (m) => warnings.push(m), rootedAt(repo))).toBeUndefined();
      expect(warnings.join("\n")).toContain(join(repo, ".mcx.yaml"));
    }
  });

  test("a git that cannot be spawned degrades LOUDLY, not silently", () => {
    // Real failure mode: on a saturated box fork() fails in milliseconds, so the
    // root probe returns "unavailable". Skipping the layer is the safe direction,
    // but doing it without a word is the same silent fall-open this module exists
    // to remove — and it is how this very test flaked before the fix.
    const root = makeRepo("repo-nogit");
    const nested = join(root, "packages", "thing");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, ".mcx.yaml"), "version: 1\nprofile: null\ninitial: impl\nphases: {}\n");
    const warnings: string[] = [];
    expect(
      findManifestProfile(
        nested,
        (m) => warnings.push(m),
        () => ({ kind: "git-unavailable", reason: "spawn-failed", detail: "EAGAIN" }),
      ),
    ).toBeUndefined();
    expect(warnings.join("\n")).toContain("git unavailable");
  });

  test("undefined cwd contributes nothing", () => {
    expect(findManifestProfile(undefined)).toBeUndefined();
  });
});
