/**
 * Patch strategies for the local `claude` binary.
 *
 * Background: starting in claude-code 2.1.120, the binary rejects `--sdk-url`
 * unless the host is in a hardcoded allowlist. mcx spawns claude with a
 * `--sdk-url` pointing at the local daemon, so post-2.1.120 binaries refuse
 * to connect. See issue #1808 for the full reverse-engineering report.
 *
 * Each strategy is a pure byte transform that's length-preserving (so the
 * Mach-O layout stays valid pre-resign). The patcher applies the matching
 * strategy to a *copy* of the source binary — the user's installed claude
 * is never modified in place.
 *
 * Adding a new strategy: append to BUILTIN_STRATEGIES with a `matches`
 * predicate that's tighter than any later entry. Registry order matters —
 * the first match wins.
 */

export interface ValidateResult {
  ok: boolean;
  reason?: string;
}

export interface PatchStrategy {
  /** Stable identifier persisted in meta.json (e.g. "host-check-ipv6-loopback-v1"). */
  id: string;
  /** One-line human description for logs and `mcx claude patch-update` output. */
  description: string;
  /** Returns true if this strategy applies to the given claude version. */
  matches: (version: string) => boolean;
  /** Length-preserving byte transform. Returns a new buffer; does not mutate input. */
  apply: (src: Uint8Array) => Uint8Array;
  /** Sanity-check the patched bytes. Returns { ok: false, reason } on failure. */
  validate: (patched: Uint8Array) => ValidateResult;
}

/**
 * Compare semver-ish version strings (major.minor.patch, no prerelease).
 * Returns negative/zero/positive like Array.sort. Non-numeric segments
 * compare as 0 (so "2.1.121" vs "2.1.121-dev" treats both as equal).
 */
export function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => Number.parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** Count non-overlapping byte-string occurrences in a buffer. */
export function countOccurrences(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let i = 0;
  outer: while (i <= haystack.length - needle.length) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        i++;
        continue outer;
      }
    }
    count++;
    i += needle.length;
  }
  return count;
}

/** Replace all non-overlapping occurrences of `find` with `replace` (must be equal length). */
export function replaceAllBytes(buf: Uint8Array, find: Uint8Array, replace: Uint8Array): Uint8Array {
  if (find.length !== replace.length) {
    throw new Error(`replaceAllBytes: length mismatch (find=${find.length} replace=${replace.length})`);
  }
  const out = new Uint8Array(buf);
  let i = 0;
  outer: while (i <= out.length - find.length) {
    for (let j = 0; j < find.length; j++) {
      if (out[i + j] !== find[j]) {
        i++;
        continue outer;
      }
    }
    out.set(replace, i);
    i += find.length;
  }
  return out;
}

const enc = new TextEncoder();

/**
 * Strategy: no-op for versions before the host check was introduced.
 * 2.1.119 and earlier accept `ws://localhost:...` directly — no patching needed.
 */
export const STRATEGY_NOOP_PRE_2_1_120: PatchStrategy = {
  id: "noop-pre-2.1.120",
  description: "No patch needed (claude < 2.1.120 accepts --sdk-url with any host).",
  matches: (version) => compareVersion(version, "2.1.120") < 0,
  apply: (src) => new Uint8Array(src),
  validate: () => ({ ok: true }),
};

/**
 * Strategy: rewrite the FedStart staging hostname to an IPv6-loopback literal.
 *
 * The 5-host allowlist is built at runtime from two sources: two hardcoded
 * strings (`api.anthropic.com`, `api-staging.anthropic.com`) and three
 * fedstart origins spread from `sL_` via `new URL(H).hostname`. We replace
 * `claude-staging.fedstart.com` everywhere it appears (4 sites in 2.1.121:
 * the source-code `sL_` array literal in two bundled copies, and two
 * length-prefixed atoms in the binary string table). The replacement
 * `[000:000:000:000:000:0:0:1]` is the same length (27 bytes) and
 * canonicalizes to `[::1]` via WHATWG URL parsing.
 *
 * Validated end-to-end against 2.1.121 on 2026-04-27: full SDK protocol
 * round-trip (init → assistant inference → clean close). See issue #1808.
 */
export const STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1: PatchStrategy = {
  id: "host-check-ipv6-loopback-v1",
  description: "Replace claude-staging.fedstart.com with [000:000:000:000:000:0:0:1] (canonicalizes to [::1]).",
  matches: (version) => compareVersion(version, "2.1.120") >= 0 && compareVersion(version, "2.1.121") <= 0,
  apply: (src) => {
    const find = enc.encode("claude-staging.fedstart.com");
    const replace = enc.encode("[000:000:000:000:000:0:0:1]");
    return replaceAllBytes(src, find, replace);
  },
  validate: (patched) => {
    const find = enc.encode("claude-staging.fedstart.com");
    const replace = enc.encode("[000:000:000:000:000:0:0:1]");
    const before = countOccurrences(patched, find);
    const after = countOccurrences(patched, replace);
    if (before !== 0) {
      return { ok: false, reason: `${before} unreplaced occurrences of source string remain` };
    }
    if (after !== 4) {
      return { ok: false, reason: `expected 4 replacement occurrences, found ${after}` };
    }
    return { ok: true };
  },
};

export const BUILTIN_STRATEGIES: readonly PatchStrategy[] = [
  STRATEGY_NOOP_PRE_2_1_120,
  STRATEGY_HOST_CHECK_IPV6_LOOPBACK_V1,
];

/**
 * Resolve the strategy for a given version. Returns null if no built-in
 * strategy matches — caller should treat as "unsupported, file an issue".
 */
export function resolveStrategy(
  version: string,
  registry: readonly PatchStrategy[] = BUILTIN_STRATEGIES,
): PatchStrategy | null {
  for (const s of registry) {
    if (s.matches(version)) return s;
  }
  return null;
}
