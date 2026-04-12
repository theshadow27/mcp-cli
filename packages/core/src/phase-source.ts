/**
 * Phase source URI parser.
 *
 * Day-one accepted forms (file kind only):
 *   - ./relative/path.ts           resolved against manifest directory
 *   - /absolute/path.ts            as-is
 *   - file:///absolute/path.ts     file URI
 *
 * Parsed-but-future forms (not yet installable; callers surface rejection):
 *   - github:owner/repo/path.ts@version#sha256=<64 hex>
 *   - https://example.com/phase.ts#sha256=<64 hex>
 *
 * Integrity note: `#sha256=` uses 64 lowercase hex chars, NOT W3C Subresource
 * Integrity's base64 form (`sha256-<base64>`). Copying an npm `integrity`
 * value will not work; convert base64 → hex first.
 *
 * Relative paths are contained within `manifestDir` — `../..` escapes are
 * rejected. This prevents future remote manifests from reading arbitrary
 * files on the host.
 *
 * The discriminated union is shaped now so adding remote support later is a
 * resolver change, not a data-model migration. See #1297.
 */

import { isAbsolute, resolve, sep } from "node:path";

export type PhaseSource =
  | { kind: "file"; absPath: string }
  | { kind: "github"; owner: string; repo: string; path: string; version: string; hash: string }
  | { kind: "https"; url: string; hash: string };

export type PhaseSourceResult = PhaseSource | { kind: "error"; reason: string };

const SHA256_RE = /^[0-9a-f]{64}$/i;

export function parseSource(raw: string, manifestDir: string): PhaseSourceResult {
  if (raw.length === 0) {
    return { kind: "error", reason: "source must be a non-empty string" };
  }

  if (raw.startsWith("github:")) return parseGithub(raw);
  if (raw.startsWith("https://")) return parseHttps(raw);
  if (raw.startsWith("http://")) {
    return { kind: "error", reason: "insecure http:// sources are not supported; use https://" };
  }
  if (raw.startsWith("file://")) return parseFileUri(raw);

  // Bare path: absolute or relative.
  if (isAbsolute(raw)) return { kind: "file", absPath: raw };
  if (raw.startsWith("./") || raw.startsWith("../")) {
    if (!isAbsolute(manifestDir)) {
      return { kind: "error", reason: `manifestDir must be absolute, got ${manifestDir}` };
    }
    const absPath = resolve(manifestDir, raw);
    const prefix = manifestDir.endsWith(sep) ? manifestDir : manifestDir + sep;
    if (absPath !== manifestDir && !absPath.startsWith(prefix)) {
      return {
        kind: "error",
        reason: `source escapes manifest directory: ${raw} resolves to ${absPath}`,
      };
    }
    return { kind: "file", absPath };
  }

  return {
    kind: "error",
    reason: `unrecognized source ${JSON.stringify(raw)}: expected ./relative, /absolute, file://, github:, or https://`,
  };
}

/**
 * Returns a human-readable rejection for install-time surfacing when a
 * parsed source is valid but not yet installable. Returns null for
 * installable sources (kind === "file").
 */
export function rejectionForInstall(src: PhaseSource): string | null {
  if (src.kind === "file") return null;
  return "remote sources not yet supported";
}

function parseFileUri(raw: string): PhaseSourceResult {
  // file:///abs/path — the path begins after file://
  const rest = raw.slice("file://".length);
  if (rest.length === 0 || rest[0] !== "/") {
    return { kind: "error", reason: `file:// URI must have an absolute path: ${raw}` };
  }
  // Reject unencoded # or ? — they're valid filename chars on POSIX, so
  // silently stripping them would truncate paths. Users must percent-encode.
  if (rest.includes("#") || rest.includes("?")) {
    return {
      kind: "error",
      reason: `file:// URI contains unencoded '#' or '?'; percent-encode them (%23, %3F): ${raw}`,
    };
  }
  let path: string;
  try {
    path = decodeURIComponent(rest);
  } catch {
    return { kind: "error", reason: `file:// URI has malformed percent-encoding: ${raw}` };
  }
  return { kind: "file", absPath: path };
}

function parseGithub(raw: string): PhaseSourceResult {
  // github:owner/repo/path@version#sha256=abc
  const body = raw.slice("github:".length);
  const hashIdx = body.indexOf("#");
  if (hashIdx < 0) {
    return { kind: "error", reason: `github source missing #sha256=... integrity: ${raw}` };
  }
  const pathAndVersion = body.slice(0, hashIdx);
  const fragment = body.slice(hashIdx + 1);
  const hash = extractSha256(fragment);
  if (!hash) {
    return { kind: "error", reason: `github source integrity must be #sha256=<64 hex>: ${raw}` };
  }

  // Only one `@` allowed — ambiguous otherwise (path vs version).
  const atIdx = pathAndVersion.indexOf("@");
  if (atIdx < 0) {
    return { kind: "error", reason: `github source missing @version: ${raw}` };
  }
  if (pathAndVersion.indexOf("@", atIdx + 1) >= 0) {
    return {
      kind: "error",
      reason: `github source has multiple '@' — only one allowed (version separator): ${raw}`,
    };
  }
  const ownerRepoPath = pathAndVersion.slice(0, atIdx);
  const version = pathAndVersion.slice(atIdx + 1);
  if (version.length === 0) {
    return { kind: "error", reason: `github source has empty version: ${raw}` };
  }
  if (version.includes("/")) {
    return { kind: "error", reason: `github source version may not contain '/': ${raw}` };
  }

  const parts = ownerRepoPath.split("/");
  if (parts.length < 3 || !parts[0] || !parts[1] || parts.slice(2).join("/").length === 0) {
    return { kind: "error", reason: `github source must be owner/repo/path@version: ${raw}` };
  }
  const owner = parts[0];
  const repo = parts[1];
  const path = parts.slice(2).join("/");
  return { kind: "github", owner, repo, path, version, hash };
}

function parseHttps(raw: string): PhaseSourceResult {
  const hashIdx = raw.indexOf("#");
  if (hashIdx < 0) {
    return { kind: "error", reason: `https source missing #sha256=... integrity: ${raw}` };
  }
  const url = raw.slice(0, hashIdx);
  const fragment = raw.slice(hashIdx + 1);
  const hash = extractSha256(fragment);
  if (!hash) {
    return { kind: "error", reason: `https source integrity must be #sha256=<64 hex>: ${raw}` };
  }
  if (url === "https://") {
    return { kind: "error", reason: `https source has empty URL: ${raw}` };
  }
  return { kind: "https", url, hash };
}

function extractSha256(fragment: string): string | null {
  const prefix = "sha256=";
  if (!fragment.startsWith(prefix)) return null;
  const hex = fragment.slice(prefix.length);
  return SHA256_RE.test(hex) ? hex.toLowerCase() : null;
}
