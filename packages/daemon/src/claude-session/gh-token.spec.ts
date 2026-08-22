import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GH_CREDENTIAL_ENV_KEYS,
  GH_TOKEN_SOURCE_ENV_KEYS,
  type GhTokenConfig,
  type GhTokenSource,
  formatFileMode,
  ghTokensFromEnv,
  isCredentialNamespaceKey,
  isPrivateFileMode,
  loadGhTokens,
  mergeGhTokens,
  normalizeGhToken,
  normalizeGhTokens,
  parseGhTokensFile,
  readGhTokensFile,
  resolveSpawnGhToken,
} from "./gh-token";

const WORKER_TOKEN = "ghp_workerworkerworkerworkerworkerworker";
const ADMIN_TOKEN = "ghp_adminadminadminadminadminadminadmin1";
const AMBIENT_TOKEN = "ghp_ambientambientambientambientambient1";
const ISOLATED_DIR = "/home/agent/.mcp-cli/gh-isolated";

const BOTH: GhTokenSource = { worker: WORKER_TOKEN, orchestrator: ADMIN_TOKEN };
const WORKER_ONLY: GhTokenSource = { worker: WORKER_TOKEN };
const ADMIN_ONLY: GhTokenSource = { orchestrator: ADMIN_TOKEN };
const NEITHER: GhTokenSource = {};

/**
 * A daemon environment that already carries credentials under every name the
 * policy has to consider. Passing this as `sourceEnv` is what makes the scrub
 * assertions non-vacuous — a scrub of an empty env proves nothing.
 */
const DIRTY_ENV: Record<string, string | undefined> = {
  PATH: "/usr/bin",
  HOME: "/home/agent",
  GH_TOKEN: AMBIENT_TOKEN,
  GITHUB_TOKEN: AMBIENT_TOKEN,
  GH_ENTERPRISE_TOKEN: AMBIENT_TOKEN,
  GITHUB_PERSONAL_ACCESS_TOKEN: AMBIENT_TOKEN,
  GH_CONFIG_DIR: "/home/agent/.config/gh",
  GIT_ASKPASS: "/usr/bin/leaky-askpass",
  SSH_ASKPASS: "/usr/bin/leaky-askpass",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "!/usr/bin/gh auth git-credential",
  MCX_GH_TOKEN_ORCHESTRATOR: ADMIN_TOKEN,
  MCX_GH_TOKEN_WORKER: WORKER_TOKEN,
};

function resolve(tokens: GhTokenSource | GhTokenConfig, sourceEnv = DIRTY_ENV) {
  const config: GhTokenConfig = "tokens" in tokens ? (tokens as GhTokenConfig) : { tokens: tokens as GhTokenSource };
  return resolveSpawnGhToken(config, { sourceEnv, isolatedGhConfigDir: ISOLATED_DIR });
}

/** Apply a decision to a source env the way `defaultSpawn` does: spread, then override. */
function childEnv(
  decisionEnv: Record<string, string | undefined>,
  sourceEnv = DIRTY_ENV,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...sourceEnv, ...decisionEnv };
  // A key present with an `undefined` value is an unset, not an assignment.
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
  return merged;
}

describe("resolveSpawnGhToken — the deny table", () => {
  test("worker token configured → scoped injection of the worker token", () => {
    const d = resolve(WORKER_ONLY);
    expect(d.mode).toBe("scoped");
    expect(d.env.GH_TOKEN).toBe(WORKER_TOKEN);
    expect(d.env.GITHUB_TOKEN).toBe(WORKER_TOKEN);
    expect(d.warnSingleToken).toBe(false);
  });

  test("both tokens configured → the child still gets ONLY the worker token", () => {
    const d = resolve(BOTH);
    expect(d.mode).toBe("scoped");
    expect(d.env.GH_TOKEN).toBe(WORKER_TOKEN);
    expect(JSON.stringify(d)).not.toContain(ADMIN_TOKEN);
  });

  test("admin token only → denied, and the admin token is not shared", () => {
    const d = resolve(ADMIN_ONLY);
    expect(d.mode).toBe("denied");
    for (const key of GH_CREDENTIAL_ENV_KEYS) {
      expect(Object.hasOwn(d.env, key)).toBe(true);
      expect(d.env[key]).toBeUndefined();
    }
    expect(JSON.stringify(d)).not.toContain(ADMIN_TOKEN);
  });

  test("nothing configured → inherited with the single-token warning and zero overrides", () => {
    const d = resolve(NEITHER);
    expect(d.mode).toBe("inherited");
    expect(d.warnSingleToken).toBe(true);
    // Legacy behaviour must be byte-identical: no keys at all, not keys set to undefined.
    expect(Object.keys(d.env)).toEqual([]);
  });

  test("a degraded config read fails CLOSED to denied, not open to inherited", () => {
    const d = resolve({ tokens: {}, problem: "/home/agent/.mcp-cli/tokens.json is mode 0644" });
    expect(d.mode).toBe("denied");
    expect(d.problem).toContain("0644");
    expect(d.reason).toContain("0644");
    expect(d.warnSingleToken).toBe(false);
  });

  test("a degraded read denies even when the ambient env carries usable source tokens", () => {
    // The env fallback must not rescue an untrusted file: the ambient env is
    // exactly the admin credential the file was written to stop handing down.
    const d = resolve({ tokens: {}, problem: "tokens.json is not valid JSON" });
    expect(childEnv(d.env).GH_TOKEN).toBeUndefined();
    expect(childEnv(d.env).MCX_GH_TOKEN_ORCHESTRATOR).toBeUndefined();
  });
});

describe("resolveSpawnGhToken — no configuration reaches an admin credential", () => {
  const configs: GhTokenConfig[] = [
    { tokens: NEITHER },
    { tokens: WORKER_ONLY },
    { tokens: ADMIN_ONLY },
    { tokens: BOTH },
    { tokens: {}, problem: "unreadable" },
    { tokens: ADMIN_ONLY, problem: "unreadable" },
  ];

  test("no input produces an override env carrying the admin token", () => {
    for (const config of configs) {
      expect(Object.values(resolve(config).env)).not.toContain(ADMIN_TOKEN);
    }
  });

  test("no input produces a *child* env carrying the admin token under any name", () => {
    // The override map is only half the story — the child is spawned with the
    // daemon env spread underneath it, so the composed result is what matters.
    for (const config of configs) {
      const d = resolve(config);
      if (d.mode === "inherited") continue; // legacy path: documented to inherit
      expect(Object.values(childEnv(d.env))).not.toContain(ADMIN_TOKEN);
    }
  });

  test("every reason and problem string is free of token material", () => {
    for (const config of configs) {
      const { reason, problem } = resolve(config);
      for (const text of [reason, problem ?? ""]) {
        expect(text).not.toContain(WORKER_TOKEN);
        expect(text).not.toContain(ADMIN_TOKEN);
        expect(text).not.toContain(AMBIENT_TOKEN);
      }
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveSpawnGhToken — the credential namespace is cleared, not name-checked", () => {
  test("scoped and denied both clear every inherited credential-bearing var", () => {
    for (const tokens of [WORKER_ONLY, ADMIN_ONLY]) {
      const child = childEnv(resolve(tokens).env);
      for (const key of [
        "GH_ENTERPRISE_TOKEN",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "GIT_ASKPASS",
        "SSH_ASKPASS",
        ...GH_TOKEN_SOURCE_ENV_KEYS,
      ]) {
        expect(child[key]).toBeUndefined();
      }
      // Unrelated variables are untouched — this is a namespace, not an allowlist
      // over the whole environment.
      expect(child.PATH).toBe("/usr/bin");
      expect(child.HOME).toBe("/home/agent");
    }
  });

  test("an inherited GIT_CONFIG_* injection cannot survive to re-add a helper", () => {
    // DIRTY_ENV declares GIT_CONFIG_COUNT=1; the policy must own the whole
    // series, not merge with it, or the inherited entry stays live.
    const child = childEnv(resolve(ADMIN_ONLY).env);
    expect(child.GIT_CONFIG_COUNT).toBe("2");
    expect(child.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
    expect(child.GIT_CONFIG_VALUE_0).toBe("");
    expect(child.GIT_CONFIG_KEY_1).toBe("credential.helper");
    expect(child.GIT_CONFIG_VALUE_1).toBe("");
  });

  test("inherited mode changes nothing at all (byte-identical legacy spawn)", () => {
    expect(childEnv(resolve(NEITHER).env)).toEqual(childEnv({}));
  });
});

describe("resolveSpawnGhToken — the ambient gh/git fallback is closed, not merely outranked", () => {
  test("denied removes gh's hosts.yml and leaves no git credential helper", () => {
    const child = childEnv(resolve(ADMIN_ONLY).env);
    expect(child.GH_CONFIG_DIR).toBe(ISOLATED_DIR);
    expect(child.GIT_TERMINAL_PROMPT).toBe("0");
    // Both helper keys are reset to empty; nothing re-adds one.
    const values = [child.GIT_CONFIG_VALUE_0, child.GIT_CONFIG_VALUE_1];
    expect(values).toEqual(["", ""]);
    expect(Object.values(child)).not.toContain("!gh auth git-credential");
  });

  test("scoped removes hosts.yml but pins gh as the sole helper so git push still works", () => {
    const child = childEnv(resolve(WORKER_ONLY).env);
    expect(child.GH_CONFIG_DIR).toBe(ISOLATED_DIR);
    expect(child.GIT_CONFIG_COUNT).toBe("3");
    // Reset first, then re-add exactly one helper — a `store` or keychain helper
    // holding an admin credential does not survive into the scoped child.
    expect([child.GIT_CONFIG_VALUE_0, child.GIT_CONFIG_VALUE_1]).toEqual(["", ""]);
    expect(child.GIT_CONFIG_KEY_2).toBe("credential.helper");
    expect(child.GIT_CONFIG_VALUE_2).toBe("!gh auth git-credential");
  });

  test("unsetting GH_TOKEN alone would not have denied — the isolation keys are what do", () => {
    // Guards the exact defect this replaced: a decision that only clears
    // GH_TOKEN/GITHUB_TOKEN reports `denied` while gh still reads hosts.yml.
    const denied = resolve(ADMIN_ONLY);
    const credentialOnly = new Set<string>(GH_CREDENTIAL_ENV_KEYS);
    const isolationKeys = Object.keys(denied.env).filter((k) => !credentialOnly.has(k) && denied.env[k] !== undefined);
    expect(isolationKeys).toContain("GH_CONFIG_DIR");
    expect(isolationKeys.length).toBeGreaterThan(1);
  });
});

describe("normalizeGhToken", () => {
  test("accepts a plausible token verbatim", () => {
    expect(normalizeGhToken(WORKER_TOKEN)).toBe(WORKER_TOKEN);
  });

  test("trims surrounding whitespace (a trailing newline from `gh auth token`)", () => {
    expect(normalizeGhToken(`  ${WORKER_TOKEN}\n`)).toBe(WORKER_TOKEN);
  });

  test("accepts a GitHub App JWT-length value", () => {
    const jwt = `ey${"A".repeat(1200)}`;
    expect(normalizeGhToken(jwt)).toBe(jwt);
  });

  test("rejects blank, non-string, oversized, and control-character values", () => {
    expect(normalizeGhToken("")).toBeUndefined();
    expect(normalizeGhToken("   ")).toBeUndefined();
    expect(normalizeGhToken(undefined)).toBeUndefined();
    expect(normalizeGhToken(null)).toBeUndefined();
    expect(normalizeGhToken(42)).toBeUndefined();
    expect(normalizeGhToken({ token: WORKER_TOKEN })).toBeUndefined();
    expect(normalizeGhToken("a".repeat(4097))).toBeUndefined();
    expect(normalizeGhToken("ghp_has space")).toBeUndefined();
    expect(normalizeGhToken("ghp_has\nnewline")).toBeUndefined();
    expect(normalizeGhToken("ghp_has\u0000null")).toBeUndefined();
  });
});

describe("normalizeGhTokens", () => {
  test("keeps only valid keys and drops everything else", () => {
    expect(normalizeGhTokens({ worker: WORKER_TOKEN, orchestrator: "", extra: "x" })).toEqual({
      worker: WORKER_TOKEN,
    });
  });

  test("non-objects yield no tokens", () => {
    expect(normalizeGhTokens(null)).toEqual({});
    expect(normalizeGhTokens("ghp_bare")).toEqual({});
    expect(normalizeGhTokens(undefined)).toEqual({});
  });
});

describe("isCredentialNamespaceKey", () => {
  test("matches every shape a GitHub or git credential can arrive under", () => {
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "GH_CONFIG_DIR",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_ASKPASS",
      "SSH_ASKPASS",
      "GIT_TERMINAL_PROMPT",
    ]) {
      expect(isCredentialNamespaceKey(key)).toBe(true);
    }
  });

  test("leaves the worktree pin and ordinary variables alone", () => {
    for (const key of ["PATH", "HOME", "GIT_DIR", "GIT_WORK_TREE", "TRACEPARENT", "NODE_TLS_REJECT_UNAUTHORIZED"]) {
      expect(isCredentialNamespaceKey(key)).toBe(false);
    }
  });
});

describe("parseGhTokensFile", () => {
  const PATH = "/tmp/tokens.json";

  test("parses a well-formed pair", () => {
    expect(parseGhTokensFile(JSON.stringify(BOTH), PATH)).toEqual({ status: "ok", tokens: BOTH });
  });

  test("a worker-only file is well formed", () => {
    expect(parseGhTokensFile(JSON.stringify(WORKER_ONLY), PATH)).toEqual({ status: "ok", tokens: WORKER_ONLY });
  });

  test.each([
    ["truncated JSON", '{"worker": "ghp_abc'],
    ["empty", ""],
    ["whitespace only", "   \n"],
    ["an array", "[1,2]"],
    ["a bare string", '"ghp_bare"'],
    ["null", "null"],
    ["an object with neither key", '{"note": "todo"}'],
    ["a token with a stray space", '{"worker": "ghp_abc def"}'],
    ["a blank token", '{"worker": "   "}'],
  ])("rejects %s loudly, naming the path", (_label, text) => {
    const read = parseGhTokensFile(text, PATH);
    expect(read.status).toBe("error");
    if (read.status !== "error") throw new Error("unreachable");
    expect(read.problem).toContain(PATH);
  });

  test("a rejection never echoes the offending token value", () => {
    const read = parseGhTokensFile(JSON.stringify({ worker: `${WORKER_TOKEN} trailing` }), PATH);
    expect(read.status).toBe("error");
    expect(JSON.stringify(read)).not.toContain(WORKER_TOKEN);
  });
});

describe("ghTokensFromEnv", () => {
  test("reads both source vars", () => {
    expect(ghTokensFromEnv({ MCX_GH_TOKEN_WORKER: WORKER_TOKEN, MCX_GH_TOKEN_ORCHESTRATOR: ADMIN_TOKEN })).toEqual(
      BOTH,
    );
  });

  test("ignores GH_TOKEN / GITHUB_TOKEN — ambient credentials are not a configured tier", () => {
    expect(ghTokensFromEnv({ GH_TOKEN: ADMIN_TOKEN, GITHUB_TOKEN: ADMIN_TOKEN })).toEqual({});
  });
});

describe("mergeGhTokens", () => {
  test("the file wins per key, and the env fills the gaps", () => {
    expect(mergeGhTokens({ worker: WORKER_TOKEN }, { worker: "ghp_env", orchestrator: ADMIN_TOKEN })).toEqual({
      worker: WORKER_TOKEN,
      orchestrator: ADMIN_TOKEN,
    });
  });

  test("two empty sources merge to empty", () => {
    expect(mergeGhTokens({}, {})).toEqual({});
  });
});

describe("isPrivateFileMode / formatFileMode", () => {
  test("0600 and 0400 are private", () => {
    expect(isPrivateFileMode(0o100600)).toBe(true);
    expect(isPrivateFileMode(0o100400)).toBe(true);
  });

  test("any group or other bit is not private", () => {
    expect(isPrivateFileMode(0o100640)).toBe(false);
    expect(isPrivateFileMode(0o100604)).toBe(false);
    expect(isPrivateFileMode(0o100666)).toBe(false);
  });

  test("renders permission bits the way an operator would chmod them", () => {
    expect(formatFileMode(0o100644)).toBe("0644");
    expect(formatFileMode(0o100600)).toBe("0600");
    expect(formatFileMode(0o100400)).toBe("0400");
  });
});

describe("readGhTokensFile / loadGhTokens — the on-disk path", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcx-gh-tokens-"));
  let seq = 0;

  /** Write a tokens file at an explicit mode and return its path. */
  function tokensFile(content: string, mode = 0o600): string {
    const path = join(dir, `tokens-${seq++}.json`);
    writeFileSync(path, content, { mode });
    chmodSync(path, mode); // writeFileSync's mode is subject to umask
    return path;
  }

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a 0600 well-formed file loads both tokens", () => {
    const read = readGhTokensFile(tokensFile(JSON.stringify(BOTH)));
    expect(read).toEqual({ status: "ok", tokens: BOTH });
  });

  test("a 0400 file is accepted — read-only is at least as private as 0600", () => {
    const read = readGhTokensFile(tokensFile(JSON.stringify(WORKER_ONLY), 0o400));
    expect(read).toEqual({ status: "ok", tokens: WORKER_ONLY });
  });

  test("a missing file is `absent`, not an error — that is the unconfigured box", () => {
    expect(readGhTokensFile(join(dir, "no-such-file.json"))).toEqual({ status: "absent" });
  });

  test.each([
    ["0644", 0o644],
    ["0640", 0o640],
    ["0604", 0o604],
    ["0666", 0o666],
  ])("mode %s is rejected loudly, naming the path and the octal mode", (_label, mode) => {
    const path = tokensFile(JSON.stringify(BOTH), mode);
    const read = readGhTokensFile(path);
    expect(read.status).toBe("error");
    if (read.status !== "error") throw new Error("unreachable");
    expect(read.problem).toContain(path);
    expect(read.problem).toContain(formatFileMode(mode));
    expect(read.problem).not.toContain(ADMIN_TOKEN);
  });

  test("a directory in the file's place is rejected rather than read", () => {
    const read = readGhTokensFile(dir);
    expect(read.status).toBe("error");
  });

  test("a symlink is validated by the inode actually read, not the link", () => {
    // fstat-on-the-descriptor closes the stat-then-read TOCTOU: a 0777 symlink
    // pointing at a 0600 file is fine, because the file is what gets read.
    const target = tokensFile(JSON.stringify(WORKER_ONLY));
    const link = join(dir, `link-${seq++}.json`);
    symlinkSync(target, link);
    expect(readGhTokensFile(link)).toEqual({ status: "ok", tokens: WORKER_ONLY });
  });

  test("a truncated file — a spawn racing a non-atomic write — is an error, not empty", () => {
    const read = readGhTokensFile(tokensFile('{\n  "worker": "ghp_abc'));
    expect(read.status).toBe("error");
    if (read.status !== "error") throw new Error("unreachable");
    expect(read.problem).toContain("JSON");
  });

  test("loadGhTokens: an error read yields a problem and NO tokens (fail closed)", () => {
    const path = tokensFile(JSON.stringify(BOTH), 0o644);
    const config = loadGhTokens({ MCX_GH_TOKEN_WORKER: WORKER_TOKEN }, path);
    expect(config.tokens).toEqual({});
    expect(config.problem).toContain("0644");
    // And the env fallback did not silently rescue it.
    expect(config.tokens.worker).toBeUndefined();
  });

  test("loadGhTokens: an absent file falls through to the env source", () => {
    const config = loadGhTokens({ MCX_GH_TOKEN_WORKER: WORKER_TOKEN }, join(dir, "absent.json"));
    expect(config).toEqual({ tokens: { worker: WORKER_TOKEN } });
  });

  test("loadGhTokens: the file wins per key over the env", () => {
    const path = tokensFile(JSON.stringify({ worker: WORKER_TOKEN }));
    const config = loadGhTokens({ MCX_GH_TOKEN_WORKER: "ghp_env", MCX_GH_TOKEN_ORCHESTRATOR: ADMIN_TOKEN }, path);
    expect(config).toEqual({ tokens: { worker: WORKER_TOKEN, orchestrator: ADMIN_TOKEN } });
  });

  test("end to end: a 0644 tokens file makes every spawn denied, not admin-inheriting", () => {
    const path = tokensFile(JSON.stringify(BOTH), 0o644);
    const decision = resolve(loadGhTokens({}, path));
    expect(decision.mode).toBe("denied");
    expect(childEnv(decision.env).GH_TOKEN).toBeUndefined();
    expect(childEnv(decision.env).GH_CONFIG_DIR).toBe(ISOLATED_DIR);
  });
});
