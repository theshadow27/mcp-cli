/**
 * Harvest Claude Code's identity-OAuth constants from the installed binary.
 *
 * Same approach as the host-check patcher: scan bytes, require a *shape*
 * (TOKEN_URL assignment next to CLIENT_ID, and the P3-like array that contains
 * `user:sessions:claude_code`), not a version pin. Minified names (`P3`, `aU`)
 * change every ship; the string literals and the `_={TOKEN_URL, CLIENT_ID}`
 * object do not.
 *
 * Verified against claude 2.1.257. `g1` (refresh) sends
 * `scope: (passed.length ? passed : P3).join(" ")`.
 */

export interface HarvestedClaudeOAuth {
  tokenUrl: string;
  clientId: string;
  /** Default identity scopes (`P3`). Not the console union, not design/projects. */
  scopes: string[];
}

/**
 * Last-known identity-OAuth constants from claude 2.1.257 / 2.1.267.
 *
 * Used when the installed binary cannot be harvested (missing P3, no claude on
 * PATH, module reshaped). TOKEN_URL and CLIENT_ID have been stable across the
 * versions we have scanned; scopes match the identity array that contains
 * `user:sessions:claude_code`.
 */
export const FALLBACK_CLAUDE_OAUTH: HarvestedClaudeOAuth = {
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  scopes: ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"],
};

const TOKEN_ASSIGN = 'TOKEN_URL:"https://';
const TOKEN_ASSIGN_RE = /TOKEN_URL:"(https:\/\/[^"]+\/v1\/oauth\/token)"/;
/** Negative lookbehind so `DESIGN_CLIENT_ID` (same window) is not harvested. */
const CLIENT_ID_RE = /(?<![A-Za-z0-9_])CLIENT_ID:"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;
const SESSIONS_SCOPE = "user:sessions:claude_code";
const LOOKBACK = 4_000;
const LOOKAHEAD = 4_000;

export class OAuthHarvestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthHarvestError";
  }
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0;
  const buf = Buffer.isBuffer(haystack)
    ? haystack
    : Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength);
  return buf.indexOf(needle);
}

const enc = new TextEncoder();
const dec = new TextDecoder("latin1");

/**
 * Pull TOKEN_URL, CLIENT_ID, and the identity scope list out of a claude binary.
 *
 * Throws OAuthHarvestError when the live JS module is missing or reshaped —
 * same failure mode as the patcher when ORIGINS moves.
 */
export function harvestClaudeOAuthConstants(bytes: Uint8Array): HarvestedClaudeOAuth {
  const tokenNeedle = enc.encode(TOKEN_ASSIGN);
  const idx = indexOfBytes(bytes, tokenNeedle);
  if (idx < 0) {
    throw new OAuthHarvestError(
      "TOKEN_URL assignment not found in claude binary — oauth module reshaped (file an issue)",
    );
  }
  const start = Math.max(0, idx - LOOKBACK);
  const end = Math.min(bytes.length, idx + LOOKAHEAD);
  const win = dec.decode(bytes.subarray(start, end));

  const token = TOKEN_ASSIGN_RE.exec(win);
  if (!token) {
    throw new OAuthHarvestError("TOKEN_URL assignment was not a platform.claude.com v1/oauth/token URL");
  }
  // CLIENT_ID sits after TOKEN_URL on the same `_={...}` object. Search only
  // that tail so an earlier `DESIGN_CLIENT_ID` in the lookback cannot win.
  const afterToken = win.slice(token.index + token[0].length);
  const client = CLIENT_ID_RE.exec(afterToken);
  if (!client) {
    throw new OAuthHarvestError("CLIENT_ID not found next to TOKEN_URL — oauth module reshaped (file an issue)");
  }
  const scopes = parseIdentityScopes(win);
  return { tokenUrl: token[1], clientId: client[1], scopes };
}

/**
 * Parse the array that contains `user:sessions:claude_code`, resolving minified
 * aliases (`aU="user:profile"`) from assignments in the same window.
 */
function parseIdentityScopes(win: string): string[] {
  const quoted = `"${SESSIONS_SCOPE}"`;
  const hit = win.indexOf(quoted);
  if (hit < 0) {
    throw new OAuthHarvestError(`"${SESSIONS_SCOPE}" not found next to TOKEN_URL — oauth module reshaped`);
  }
  const open = win.lastIndexOf("[", hit);
  const close = win.indexOf("]", hit);
  if (open < 0 || close < 0 || close < open) {
    throw new OAuthHarvestError("could not find the identity-scope array around user:sessions:claude_code");
  }
  const aliases = new Map<string, string>();
  const aliasRe = /([A-Za-z_$][\w$]*)="(user:[^"]+)"/g;
  const before = win.slice(0, open);
  let m: RegExpExecArray | null = aliasRe.exec(before);
  while (m) {
    aliases.set(m[1], m[2]);
    m = aliasRe.exec(before);
  }
  const scopes: string[] = [];
  for (const raw of win.slice(open + 1, close).split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const lit = /^"([^"]+)"$/.exec(token);
    if (lit) {
      scopes.push(lit[1]);
      continue;
    }
    const resolved = aliases.get(token);
    if (!resolved) {
      throw new OAuthHarvestError(`unresolved identity-scope element "${token}" — oauth module reshaped`);
    }
    scopes.push(resolved);
  }
  if (!scopes.includes(SESSIONS_SCOPE)) {
    throw new OAuthHarvestError("parsed scope array did not contain user:sessions:claude_code");
  }
  if (scopes.length < 3) {
    throw new OAuthHarvestError(`identity-scope array too short (${scopes.length})`);
  }
  return scopes;
}
