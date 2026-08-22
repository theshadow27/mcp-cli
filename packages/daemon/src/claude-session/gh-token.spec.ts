import { describe, expect, test } from "bun:test";
import {
  GH_CREDENTIAL_ENV_KEYS,
  GH_TOKEN_SOURCE_ENV_KEYS,
  type GhTokenSource,
  ghTokenRole,
  ghTokensFromEnv,
  isPrivateFileMode,
  mergeGhTokens,
  normalizeGhToken,
  normalizeGhTokens,
  parseGhTokensFile,
  resolveSpawnGhToken,
} from "./gh-token";

const WORKER_TOKEN = "ghp_workerworkerworkerworkerworkerworker";
const ADMIN_TOKEN = "ghp_adminadminadminadminadminadminadmin1";

const BOTH: GhTokenSource = { worker: WORKER_TOKEN, orchestrator: ADMIN_TOKEN };
const WORKER_ONLY: GhTokenSource = { worker: WORKER_TOKEN };
const ADMIN_ONLY: GhTokenSource = { orchestrator: ADMIN_TOKEN };
const NEITHER: GhTokenSource = {};

describe("resolveSpawnGhToken — worker role (deny table)", () => {
  test("worker token configured → scoped injection of the worker token", () => {
    const d = resolveSpawnGhToken("worker", WORKER_ONLY);
    expect(d.mode).toBe("scoped");
    expect(d.env.GH_TOKEN).toBe(WORKER_TOKEN);
    expect(d.env.GITHUB_TOKEN).toBe(WORKER_TOKEN);
    expect(d.warnSingleToken).toBe(false);
  });

  test("both tokens configured → worker still gets ONLY the worker token", () => {
    const d = resolveSpawnGhToken("worker", BOTH);
    expect(d.mode).toBe("scoped");
    expect(d.env.GH_TOKEN).toBe(WORKER_TOKEN);
    expect(d.env.GITHUB_TOKEN).toBe(WORKER_TOKEN);
    expect(JSON.stringify(d)).not.toContain(ADMIN_TOKEN);
  });

  test("admin token only → denied: inherited credentials are stripped, admin is not shared", () => {
    const d = resolveSpawnGhToken("worker", ADMIN_ONLY);
    expect(d.mode).toBe("denied");
    for (const key of GH_CREDENTIAL_ENV_KEYS) {
      expect(Object.hasOwn(d.env, key)).toBe(true);
      expect(d.env[key]).toBeUndefined();
    }
    expect(JSON.stringify(d)).not.toContain(ADMIN_TOKEN);
  });

  test("nothing configured → inherited with the single-token warning and zero overrides", () => {
    const d = resolveSpawnGhToken("worker", NEITHER);
    expect(d.mode).toBe("inherited");
    expect(d.warnSingleToken).toBe(true);
    // Legacy behaviour must be byte-identical: no keys at all, not keys set to undefined.
    expect(Object.keys(d.env)).toEqual([]);
  });

  test("scoped and denied both scrub the source env vars from the child", () => {
    for (const tokens of [WORKER_ONLY, ADMIN_ONLY]) {
      const d = resolveSpawnGhToken("worker", tokens);
      for (const key of GH_TOKEN_SOURCE_ENV_KEYS) {
        expect(Object.hasOwn(d.env, key)).toBe(true);
        expect(d.env[key]).toBeUndefined();
      }
    }
  });

  test("no worker input can produce an env carrying the admin token", () => {
    const sources: GhTokenSource[] = [NEITHER, WORKER_ONLY, ADMIN_ONLY, BOTH];
    for (const tokens of sources) {
      const d = resolveSpawnGhToken("worker", tokens);
      expect(Object.values(d.env)).not.toContain(ADMIN_TOKEN);
    }
  });
});

describe("resolveSpawnGhToken — orchestrator role", () => {
  test("admin token configured → injected", () => {
    const d = resolveSpawnGhToken("orchestrator", BOTH);
    expect(d.mode).toBe("orchestrator");
    expect(d.env.GH_TOKEN).toBe(ADMIN_TOKEN);
    expect(d.env.GITHUB_TOKEN).toBe(ADMIN_TOKEN);
  });

  test("no admin token → inherits ambient credentials with no overrides", () => {
    const d = resolveSpawnGhToken("orchestrator", WORKER_ONLY);
    expect(d.mode).toBe("inherited");
    expect(Object.keys(d.env)).toEqual([]);
    expect(d.warnSingleToken).toBe(false);
  });
});

describe("resolveSpawnGhToken — reasons carry no secrets", () => {
  test("every reason string is free of token material", () => {
    const roles = ["worker", "orchestrator"] as const;
    for (const role of roles) {
      for (const tokens of [NEITHER, WORKER_ONLY, ADMIN_ONLY, BOTH]) {
        const { reason } = resolveSpawnGhToken(role, tokens);
        expect(reason).not.toContain(WORKER_TOKEN);
        expect(reason).not.toContain(ADMIN_TOKEN);
        expect(reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("ghTokenRole", () => {
  test("worktree spawns are workers", () => {
    expect(ghTokenRole({ worktree: "issue-1510" })).toBe("worker");
  });

  test("non-worktree spawns keep the orchestrator tier", () => {
    expect(ghTokenRole({})).toBe("orchestrator");
    expect(ghTokenRole({ worktree: null })).toBe("orchestrator");
    expect(ghTokenRole({ worktree: "" })).toBe("orchestrator");
  });
});

describe("normalizeGhToken", () => {
  test("accepts a plausible token verbatim", () => {
    expect(normalizeGhToken(WORKER_TOKEN)).toBe(WORKER_TOKEN);
  });

  test("trims surrounding whitespace (a trailing newline from `gh auth token`)", () => {
    expect(normalizeGhToken(`  ${WORKER_TOKEN}\n`)).toBe(WORKER_TOKEN);
  });

  test("rejects blank, non-string, oversized, and control-character values", () => {
    expect(normalizeGhToken("")).toBeUndefined();
    expect(normalizeGhToken("   ")).toBeUndefined();
    expect(normalizeGhToken(undefined)).toBeUndefined();
    expect(normalizeGhToken(null)).toBeUndefined();
    expect(normalizeGhToken(42)).toBeUndefined();
    expect(normalizeGhToken({ token: WORKER_TOKEN })).toBeUndefined();
    expect(normalizeGhToken("a".repeat(513))).toBeUndefined();
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

describe("parseGhTokensFile", () => {
  test("parses a well-formed pair", () => {
    expect(parseGhTokensFile(JSON.stringify(BOTH))).toEqual(BOTH);
  });

  test("malformed, empty, or missing content degrades to no tokens", () => {
    expect(parseGhTokensFile("{not json")).toEqual({});
    expect(parseGhTokensFile("")).toEqual({});
    expect(parseGhTokensFile("   ")).toEqual({});
    expect(parseGhTokensFile(null)).toEqual({});
    expect(parseGhTokensFile(undefined)).toEqual({});
    expect(parseGhTokensFile("[1,2]")).toEqual({});
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

describe("isPrivateFileMode", () => {
  test("0600 and 0400 are private", () => {
    expect(isPrivateFileMode(0o100600)).toBe(true);
    expect(isPrivateFileMode(0o100400)).toBe(true);
  });

  test("any group or other bit is not private", () => {
    expect(isPrivateFileMode(0o100640)).toBe(false);
    expect(isPrivateFileMode(0o100604)).toBe(false);
    expect(isPrivateFileMode(0o100666)).toBe(false);
  });
});
