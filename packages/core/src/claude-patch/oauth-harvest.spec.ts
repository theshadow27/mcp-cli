import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { restoreEnv, unsetEnv } from "../../../../test/env";
import { FALLBACK_CLAUDE_OAUTH, OAuthHarvestError, harvestClaudeOAuthConstants } from "./oauth-harvest";
import { resolveSourceClaudePath } from "./patcher";

const enc = new TextEncoder();

/** Captured from claude 2.1.257's live JS module (P3 + TOKEN_URL + CLIENT_ID). */
const FIXTURE_2_1_257 = `C_="user:inference",aU="user:profile",s="org:create_api_key",od="oauth-2025-04-20",r=[s,aU],P3=[aU,C_,"user:sessions:claude_code","user:mcp_servers","user:file_upload"],jxn=te([...r,...P3]),WQ=["user:design:read","user:design:write"],MAr=["user:projects:read","user:projects:write","user:plugins"];function Zge(t){if(!Array.isArray(t))return[];let o=MAr;return t.filter((e)=>o.includes(e))}var _={BASE_API_URL:"https://api.anthropic.com",CONSOLE_AUTHORIZE_URL:"https://platform.claude.com/oauth/authorize",CLAUDE_AI_AUTHORIZE_URL:"https://claude.com/cai/oauth/authorize",CLAUDE_AI_ORIGIN:"https://claude.ai",TOKEN_URL:"https://platform.claude.com/v1/oauth/token",API_KEY_URL:"https://api.anthropic.com/api/oauth/claude_cli/create_api_key",ROLES_URL:"https://api.anthropic.com/api/oauth/claude_cli/roles",CONSOLE_SUCCESS_URL:"https://platform.claude.com/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code",CLAUDEAI_SUCCESS_URL:"https://platform.claude.com/oauth/code/success?app=claude-code",MANUAL_REDIRECT_URL:"https://platform.claude.com/oauth/code/callback",CLIENT_ID:"9d1c250a-e61b-44d9-88ed-5944d1962f5e",DESIGN_CLIENT_ID:"59637612-477b-4836-a601-b0589eda7704"}`;

/**
 * Captured from claude 2.1.332's live JS module, trimmed to the constants the
 * harvester reads. `user:sessions:claude_code` is now its own alias (`xje`),
 * an unrelated `["",...]` suffix array sits just before it, and a two-element
 * `[profile, sessions]` array (`Ato`) precedes P3 (`n`).
 */
const FIXTURE_2_1_332 = `var bX=["","-staging-oauth","-local-oauth","-custom-oauth"];var Rje=31536000;var tCa=Math.round(Rje/86400),tI="user:inference",a3="user:profile",xje="user:sessions:claude_code",Ato=[a3,xje];var Oje="user:plugins",Lqr="user:projects:read",Nqr="user:projects:write",Fqr="user:privacy_consents:write";var c="org:create_api_key",tp="oauth-2025-04-20",Rto=[c,a3],n=[a3,tI,xje,"user:mcp_servers","user:file_upload"];function j5s(){let t=R([...Rto,...$Rn()]);return t}var jSt=["user:design:read","user:design:write"],r=[Lqr,Nqr,Fqr];var o={BASE_API_URL:"https://api.anthropic.com",CONSOLE_AUTHORIZE_URL:"https://platform.claude.com/oauth/authorize",CLAUDE_AI_AUTHORIZE_URL:"https://claude.com/cai/oauth/authorize",CLAUDE_AI_ORIGIN:"https://claude.ai",TOKEN_URL:"https://platform.claude.com/v1/oauth/token",API_KEY_URL:"https://api.anthropic.com/api/oauth/claude_cli/create_api_key",MANUAL_REDIRECT_URL:"https://platform.claude.com/oauth/code/callback",CLIENT_ID:"9d1c250a-e61b-44d9-88ed-5944d1962f5e",DESIGN_CLIENT_ID:"59637612-477b-4836-a601-b0589eda7704",CHATS_CLIENT_ID:"00000000-0000-4000-8000-00000000c4a9",OAUTH_FILE_SUFFIX:""}`;

describe("harvestClaudeOAuthConstants", () => {
  test("pulls TOKEN_URL, CLIENT_ID, and P3 from the 2.1.257 shape", () => {
    const harvested = harvestClaudeOAuthConstants(enc.encode(FIXTURE_2_1_257));
    expect(harvested.tokenUrl).toBe("https://platform.claude.com/v1/oauth/token");
    expect(harvested.clientId).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(harvested.scopes).toEqual([
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload",
    ]);
    expect(harvested).toEqual(FALLBACK_CLAUDE_OAUTH);
  });

  test("does not pick up design/projects scopes sitting next to P3", () => {
    const harvested = harvestClaudeOAuthConstants(enc.encode(FIXTURE_2_1_257));
    expect(harvested.scopes.join(" ")).not.toContain("design");
    expect(harvested.scopes.join(" ")).not.toContain("projects");
    expect(harvested.scopes).not.toContain("org:create_api_key");
  });

  test("still works when minified alias names change", () => {
    const renamed = FIXTURE_2_1_257.replaceAll("aU=", "prof=")
      .replaceAll("[aU,", "[prof,")
      .replaceAll("C_=", "inf=")
      .replaceAll(",C_,", ",inf,");
    const harvested = harvestClaudeOAuthConstants(enc.encode(renamed));
    expect(harvested.scopes[0]).toBe("user:profile");
    expect(harvested.scopes[1]).toBe("user:inference");
  });

  test("throws when TOKEN_URL is missing", () => {
    expect(() => harvestClaudeOAuthConstants(enc.encode('CLIENT_ID:"9d1c250a-e61b-44d9-88ed-5944d1962f5e"'))).toThrow(
      OAuthHarvestError,
    );
  });

  test("throws when the sessions scope array is gone", () => {
    const broken = FIXTURE_2_1_257.replace("user:sessions:claude_code", "user:sessions:nope");
    expect(() => harvestClaudeOAuthConstants(enc.encode(broken))).toThrow(OAuthHarvestError);
  });

  test("does not harvest DESIGN_CLIENT_ID even when it sits between TOKEN_URL and CLIENT_ID", () => {
    const shuffled = FIXTURE_2_1_257.replace(
      'CLIENT_ID:"9d1c250a-e61b-44d9-88ed-5944d1962f5e",DESIGN_CLIENT_ID:"59637612-477b-4836-a601-b0589eda7704"',
      'DESIGN_CLIENT_ID:"59637612-477b-4836-a601-b0589eda7704",CLIENT_ID:"9d1c250a-e61b-44d9-88ed-5944d1962f5e"',
    );
    const harvested = harvestClaudeOAuthConstants(enc.encode(shuffled));
    expect(harvested.clientId).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  });

  test("resolves a fully-literal P3 with no minified aliases", () => {
    const literal = FIXTURE_2_1_257.replace(
      'P3=[aU,C_,"user:sessions:claude_code","user:mcp_servers","user:file_upload"]',
      'P3=["user:profile","user:inference","user:sessions:claude_code","user:mcp_servers","user:file_upload"]',
    );
    expect(harvestClaudeOAuthConstants(enc.encode(literal)).scopes).toEqual([
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload",
    ]);
  });

  test("throws when CLIENT_ID is missing", () => {
    const broken = FIXTURE_2_1_257.replace('CLIENT_ID:"9d1c250a-e61b-44d9-88ed-5944d1962f5e"', "");
    expect(() => harvestClaudeOAuthConstants(enc.encode(broken))).toThrow(OAuthHarvestError);
  });

  test("throws when a P3 element is an unresolved alias", () => {
    const broken = FIXTURE_2_1_257.replace("P3=[aU,C_,", "P3=[nope,C_,");
    expect(() => harvestClaudeOAuthConstants(enc.encode(broken))).toThrow(/unresolved identity-scope element/);
  });
  test("pulls TOKEN_URL, CLIENT_ID, and P3 from the 2.1.332 shape (aliased sessions scope)", () => {
    expect(harvestClaudeOAuthConstants(enc.encode(FIXTURE_2_1_332))).toEqual(FALLBACK_CLAUDE_OAUTH);
  });

  test("skips the [profile, sessions] subset array and the empty-string suffix array", () => {
    const { scopes } = harvestClaudeOAuthConstants(enc.encode(FIXTURE_2_1_332));
    expect(scopes).not.toContain("");
    expect(scopes).toHaveLength(5);
  });

  test("throws when two distinct identity-scope arrays are present", () => {
    const doubled = FIXTURE_2_1_332.replace("var jSt=", 'var dup=[a3,tI,xje,"user:mcp_servers"];var jSt=');
    expect(() => harvestClaudeOAuthConstants(enc.encode(doubled))).toThrow(/ambiguous identity-scope arrays/);
  });

  test("throws when the 2.1.332 sessions alias is unresolved", () => {
    const broken = FIXTURE_2_1_332.replace('xje="user:sessions:claude_code"', "xje=sessionsScope()");
    expect(() => harvestClaudeOAuthConstants(enc.encode(broken))).toThrow(OAuthHarvestError);
  });
});

describe("harvestClaudeOAuthConstants against the installed binary", () => {
  test("shape still holds on this machine's claude", () => {
    const prev = process.env.MCX_CLAUDE_BINARY;
    unsetEnv("MCX_CLAUDE_BINARY");
    let path: string | null;
    try {
      path = resolveSourceClaudePath();
    } finally {
      restoreEnv("MCX_CLAUDE_BINARY", prev);
    }
    if (!path || !existsSync(path)) return;
    const harvested = harvestClaudeOAuthConstants(new Uint8Array(readFileSync(path)));
    expect(harvested.tokenUrl).toContain("/v1/oauth/token");
    expect(harvested.clientId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(harvested.scopes).toContain("user:sessions:claude_code");
    expect(harvested.scopes).toContain("user:inference");
    expect(harvested.scopes.length).toBeGreaterThanOrEqual(3);
  });
});
