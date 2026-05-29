import { describe, expect, test } from "bun:test";
import { ResidualSecretError, assertClean, sanitizeJsonPayload, sanitizeText, scanSecrets } from "./sanitizer";

// ── AWS ────────────────────────────────────────────────────────────

describe("scanSecrets / AWS", () => {
  test("detects AKIA long-lived access key", () => {
    const r = scanSecrets("key = AKIAIOSFODNN7EXAMPLE");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "aws-access-key")).toBe(true);
  });

  test("detects ASIA STS temporary access key", () => {
    const r = scanSecrets("key = ASIAJEXAMPLEXEG456NY");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "aws-access-key")).toBe(true);
  });

  test("ignores partial AKIA prefix without full length", () => {
    const r = scanSecrets("AKIA_SHORT");
    expect(r.matches.some((m) => m.pattern === "aws-access-key")).toBe(false);
  });

  test("detects AWS secret key with context keyword", () => {
    const r = scanSecrets("aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "aws-secret-key")).toBe(true);
  });

  test("detects SecretAccessKey context", () => {
    const r = scanSecrets('SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"');
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "aws-secret-key")).toBe(true);
  });

  test("ignores bare 40-char base64 strings without context", () => {
    const r = scanSecrets("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(r.matches.some((m) => m.pattern === "aws-secret-key")).toBe(false);
  });

  test("ignores git SHA-1 hashes (40 hex chars)", () => {
    const r = scanSecrets("commit e2b5eb6721f62f7b6da14bbab9ab9380cadc080c");
    expect(r.matches.some((m) => m.pattern === "aws-secret-key")).toBe(false);
  });
});

// ── GitHub ─────────────────────────────────────────────────────────

describe("scanSecrets / GitHub tokens", () => {
  test("detects ghp_ personal access token", () => {
    const r = scanSecrets("token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "github-token")).toBe(true);
  });

  test("detects gho_ OAuth token", () => {
    const r = scanSecrets("gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "github-token")).toBe(true);
  });

  test("detects ghs_ server-to-server token", () => {
    const r = scanSecrets("ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "github-token")).toBe(true);
  });

  test("detects github_pat_ fine-grained PAT", () => {
    const token = "github_pat_11ABCDEF0GHIJKLMNOPQRS_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012345678";
    const r = scanSecrets(`token: ${token}`);
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "github-fine-grained-token")).toBe(true);
  });
});

// ── JWTs ───────────────────────────────────────────────────────────

describe("scanSecrets / JWTs", () => {
  test("detects JWT tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const r = scanSecrets(`token: ${jwt}`);
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "jwt")).toBe(true);
  });

  test("ignores two-segment eyJ strings", () => {
    const r = scanSecrets("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0");
    expect(r.matches.some((m) => m.pattern === "jwt")).toBe(false);
  });
});

// ── Authorization headers ──────────────────────────────────────────

describe("scanSecrets / Authorization headers", () => {
  test("detects Bearer token in header", () => {
    const r = scanSecrets('"Authorization": "Bearer sk-1234567890abcdefghijk"');
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "authorization-header")).toBe(true);
  });

  test("detects Basic auth in header", () => {
    const r = scanSecrets('"Authorization": "Basic dXNlcjpwYXNzd29yZDEyMzQ1"');
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "authorization-header")).toBe(true);
  });

  test("does not flag the word Authorization in prose", () => {
    const r = scanSecrets("The Authorization flow requires a redirect");
    expect(r.matches.some((m) => m.pattern === "authorization-header")).toBe(false);
  });
});

// ── API key headers ────────────────────────────────────────────────

describe("scanSecrets / API key headers", () => {
  test("detects X-API-Key header value", () => {
    const r = scanSecrets('"X-API-Key": "abcdef1234567890abcdef"');
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "generic-api-key-header")).toBe(true);
  });
});

// ── Environment variable secrets ───────────────────────────────────

describe("scanSecrets / env vars", () => {
  test("detects GITHUB_TOKEN assignment", () => {
    const r = scanSecrets("GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1234");
    expect(r.clean).toBe(false);
  });

  test("detects API_KEY in JSON", () => {
    const r = scanSecrets('{"API_KEY": "super-secret-key-value-1234"}');
    expect(r.clean).toBe(false);
  });

  test("detects DATABASE_URL with credentials", () => {
    const r = scanSecrets("DATABASE_URL=postgres://user:password123@host:5432/db");
    expect(r.clean).toBe(false);
  });

  test("detects CLIENT_SECRET", () => {
    const r = scanSecrets('"CLIENT_SECRET": "a1b2c3d4e5f6g7h8i9j0klmn"');
    expect(r.clean).toBe(false);
  });

  test("detects ANTHROPIC_API_KEY", () => {
    const r = scanSecrets("ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxx");
    expect(r.clean).toBe(false);
  });

  test("preserves key name when sanitizing env-key-value", () => {
    const r = sanitizeText('"API_KEY": "super-secret-key-value-1234"');
    expect(r.text).toContain("API_KEY");
    expect(r.text).toContain("[REDACTED:");
    expect(r.text).not.toContain("super-secret");
  });

  test("preserves key name when sanitizing well-known-env", () => {
    const r = sanitizeText("GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1234");
    expect(r.text).toContain("GITHUB_TOKEN=");
    expect(r.text).toContain("[REDACTED:");
    expect(r.text).not.toContain("ghp_");
  });

  test("preserves separator when sanitizing well-known-env with JSON", () => {
    const r = sanitizeText('"ANTHROPIC_API_KEY": "sk-ant-xxxxxxxxxxxxxxxxxxxx"');
    expect(r.text).toContain("ANTHROPIC_API_KEY");
    expect(r.text).toContain("[REDACTED:");
  });
});

// ── Platform tokens ────────────────────────────────────────────────

describe("scanSecrets / platform tokens", () => {
  test("detects npm_ token", () => {
    const r = scanSecrets("npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "npm-token")).toBe(true);
  });

  test("detects xoxb- Slack bot token", () => {
    const r = scanSecrets("xoxb-1234567890-abcdefghij");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "slack-token")).toBe(true);
  });

  test("detects xoxp- Slack user token", () => {
    const r = scanSecrets("xoxp-1234567890-abcdefghij");
    expect(r.clean).toBe(false);
  });

  test("detects sk_live_ Stripe secret key", () => {
    const r = scanSecrets("sk_live_TESTONLY00000000000000x");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "stripe-key")).toBe(true);
  });

  test("detects sk_test_ Stripe test key", () => {
    const r = scanSecrets("sk_test_TESTONLY00000000000000x");
    expect(r.clean).toBe(false);
  });

  test("detects pypi- token", () => {
    const r = scanSecrets("pypi-AgEIcHlwaS5vcmcABCDEFGH12345");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "pypi-token")).toBe(true);
  });

  test("detects sk-ant- Anthropic key literal", () => {
    const r = scanSecrets("sk-ant-api03-abcdefghijklmnopqrstuv");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "anthropic-api-key")).toBe(true);
  });
});

// ── GitLab / Google / Vault / Bitbucket ─────────────────────────────

describe("scanSecrets / additional providers", () => {
  test("detects glpat- GitLab token", () => {
    const r = scanSecrets("token: glpat-ABCDEFghijklmnopqrstuv12");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "gitlab-token")).toBe(true);
  });

  test("detects GR1348941 GitLab runner token", () => {
    const r = scanSecrets("GR1348941ABCDEFghijklmnopqrstuv12");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "gitlab-runner-token")).toBe(true);
  });

  test("detects AIza Google API key", () => {
    const r = scanSecrets("key: AIzaSyA1234567890abcdefghijklmnopqrstuv");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "google-api-key")).toBe(true);
  });

  test("detects hvs. Vault service token", () => {
    const r = scanSecrets("token: hvs.ABCDEFghijklmnopqrstuv1234");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "vault-token")).toBe(true);
  });

  test("detects hvb. Vault batch token", () => {
    const r = scanSecrets("hvb.ABCDEFghijklmnopqrstuv1234");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "vault-token")).toBe(true);
  });

  test("detects ATBB Bitbucket token", () => {
    const r = scanSecrets("ATBB1234567890abcdefghijklmnopqrstuvwxyz");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "bitbucket-token")).toBe(true);
  });
});

// ── Preview field (blocker fix) ─────────────────────────────────────

describe("scanSecrets / preview field safety", () => {
  test("preview does not contain the full secret", () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const r = scanSecrets(secret);
    expect(r.matches.length).toBeGreaterThan(0);
    const match = r.matches[0];
    expect(match.preview).not.toBe(secret);
    expect(match.preview.length).toBeLessThan(secret.length);
    expect(match.preview).toContain("***");
  });

  test("preview shows first 4 + last 2 chars for long secrets", () => {
    const r = scanSecrets("AKIAIOSFODNN7EXAMPLE");
    const match = r.matches.find((m) => m.pattern === "aws-access-key");
    expect(match).toBeDefined();
    expect(match?.preview).toBe("AKIA***LE");
  });

  test("preview shows first 2 chars for short matches", () => {
    const r = scanSecrets('"password": "hunter2x"');
    const match = r.matches.find((m) => m.pattern === "generic-secret-assignment");
    expect(match).toBeDefined();
    expect(match?.preview).toBe("hu***");
  });
});

// ── Private key blocks ─────────────────────────────────────────────

describe("scanSecrets / private keys", () => {
  test("detects RSA private key", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    const r = scanSecrets(key);
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "private-key-block")).toBe(true);
  });

  test("detects generic private key block", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----";
    const r = scanSecrets(key);
    expect(r.clean).toBe(false);
  });

  test("detects encrypted private key block", () => {
    const key = "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIE...\n-----END ENCRYPTED PRIVATE KEY-----";
    const r = scanSecrets(key);
    expect(r.clean).toBe(false);
  });
});

// ── Emails ─────────────────────────────────────────────────────────

describe("scanSecrets / emails", () => {
  test("detects email addresses", () => {
    const r = scanSecrets("contact: alice.smith@acmecorp.com");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "email")).toBe(true);
  });

  test("allows example.com emails", () => {
    const r = scanSecrets("test@example.com");
    expect(r.matches.some((m) => m.pattern === "email")).toBe(false);
  });

  test("allows noreply@anthropic.com", () => {
    const r = scanSecrets("Co-Authored-By: Claude <noreply@anthropic.com>");
    expect(r.matches.some((m) => m.pattern === "email")).toBe(false);
  });

  test("allows GitHub noreply addresses", () => {
    const r = scanSecrets("user@users.noreply.github.com");
    expect(r.matches.some((m) => m.pattern === "email")).toBe(false);
  });

  test("does not match TLD containing pipe character (regression: [A-Z|a-z] bug)", () => {
    const r = scanSecrets("user@example.c|m");
    expect(r.matches.some((m) => m.pattern === "email")).toBe(false);
  });

  test("matches emails with valid 2+ letter TLDs only", () => {
    const r = scanSecrets("user@corp.io and admin@test.engineering");
    expect(r.matches.filter((m) => m.pattern === "email").length).toBe(2);
  });
});

// ── IP addresses ───────────────────────────────────────────────────

describe("scanSecrets / IPs", () => {
  test("detects IPv4 addresses", () => {
    const r = scanSecrets("server: 172.16.254.1");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "ipv4")).toBe(true);
  });

  test("detects IPv6 addresses", () => {
    const r = scanSecrets("addr: 2001:0db8:85a3:0000:0000:8a2e:0370:7334");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "ipv6")).toBe(true);
  });

  test("allows localhost 127.0.0.1", () => {
    expect(scanSecrets("bind: 127.0.0.1").matches.some((m) => m.pattern === "ipv4")).toBe(false);
  });

  test("allows 0.0.0.0", () => {
    expect(scanSecrets("listen: 0.0.0.0").matches.some((m) => m.pattern === "ipv4")).toBe(false);
  });

  test("allows 10.0.0.x range", () => {
    expect(scanSecrets("bind: 10.0.0.1").matches.some((m) => m.pattern === "ipv4")).toBe(false);
  });

  test("detects compressed IPv6 ::1 loopback (but false-positive filtered)", () => {
    const r = scanSecrets("addr: ::1");
    expect(r.matches.some((m) => m.pattern === "ipv6-compressed")).toBe(false);
  });

  test("detects compressed IPv6 fe80:: link-local", () => {
    const r = scanSecrets("addr: fe80::");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "ipv6-compressed")).toBe(true);
  });

  test("detects compressed IPv6 2001:db8::1", () => {
    const r = scanSecrets("addr: 2001:db8::1");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "ipv6-compressed")).toBe(true);
  });

  test("allows :: unspecified address (false-positive filtered)", () => {
    expect(scanSecrets("bind: ::").matches.some((m) => m.pattern === "ipv6-compressed")).toBe(false);
  });

  test("allows subnet masks", () => {
    expect(scanSecrets("mask: 255.255.255.0").matches.some((m) => m.pattern === "ipv4")).toBe(false);
  });

  test("allows RFC 5737 documentation IPs", () => {
    expect(
      scanSecrets("example: 192.0.2.1 and 198.51.100.1 and 203.0.113.1").matches.some((m) => m.pattern === "ipv4"),
    ).toBe(false);
  });
});

// ── Home paths ─────────────────────────────────────────────────────

describe("scanSecrets / home paths", () => {
  test("detects /Users/<name>/ paths", () => {
    const r = scanSecrets("path: /Users/johndoe/projects/secret");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "home-path")).toBe(true);
  });

  test("detects /home/<name>/ paths", () => {
    const r = scanSecrets("path: /home/ubuntu/.ssh/id_rsa");
    expect(r.clean).toBe(false);
  });

  test("detects macOS Claude slug paths", () => {
    const r = scanSecrets("dir: -Users-johndoe-projects");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "home-path-slug")).toBe(true);
  });

  test("detects Linux Claude slug paths (-home-alice-)", () => {
    const r = scanSecrets("dir: -home-alice-project-foo");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "home-path-slug")).toBe(true);
  });

  test("allows /Users/Shared/", () => {
    expect(scanSecrets("/Users/Shared/data").matches.some((m) => m.pattern === "home-path")).toBe(false);
  });

  test("allows /home/runner/ (CI)", () => {
    expect(scanSecrets("/home/runner/work/project").matches.some((m) => m.pattern === "home-path")).toBe(false);
  });
});

// ── Connection strings ─────────────────────────────────────────────

describe("scanSecrets / connection strings", () => {
  test("detects MongoDB URI", () => {
    const r = scanSecrets("mongodb://admin:password@host:27017/db");
    expect(r.clean).toBe(false);
    expect(r.matches.some((m) => m.pattern === "connection-string")).toBe(true);
  });

  test("detects PostgreSQL URI", () => {
    const r = scanSecrets("postgres://user:pass@host:5432/mydb");
    expect(r.clean).toBe(false);
  });

  test("detects Redis URI", () => {
    const r = scanSecrets("redis://default:secretpass@redis.example.com:6379");
    expect(r.clean).toBe(false);
  });
});

// ── Generic secret assignments ─────────────────────────────────────

describe("scanSecrets / generic secrets", () => {
  test("detects password assignment", () => {
    const r = scanSecrets('"password": "hunter2-extended-edition"');
    expect(r.clean).toBe(false);
  });

  test("detects secret assignment", () => {
    const r = scanSecrets('"secret": "my-super-secret-value-123"');
    expect(r.clean).toBe(false);
  });

  test("does not flag masked passwords (****)", () => {
    expect(scanSecrets('"password": "********"').matches.some((m) => m.pattern === "generic-secret-assignment")).toBe(
      false,
    );
  });
});

// ── sanitizeText ───────────────────────────────────────────────────

describe("sanitizeText", () => {
  test("replaces secrets with redaction placeholders", () => {
    const r = sanitizeText("key = AKIAIOSFODNN7EXAMPLE and done");
    expect(r.text).toContain("[REDACTED:aws-access-key]");
    expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r.replacements).toBeGreaterThan(0);
  });

  test("replaces JWT tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const r = sanitizeText(`Authorization: Bearer ${jwt}`);
    expect(r.text).toContain("[REDACTED:");
    expect(r.text).not.toContain("eyJhbGci");
  });

  test("replaces home paths", () => {
    const r = sanitizeText("working in /Users/johndoe/code/project");
    expect(r.text).toContain("[REDACTED:home-path]");
    expect(r.text).not.toContain("johndoe");
  });

  test("replaces emails", () => {
    const r = sanitizeText("from alice.smith@acmecorp.com");
    expect(r.text).toContain("[REDACTED:email]");
    expect(r.text).not.toContain("alice.smith@acmecorp.com");
  });

  test("replaces multiple different secret types", () => {
    const input = ["key = AKIAIOSFODNN7EXAMPLE", "email: alice@acmecorp.com", "server: 172.16.254.1"].join("\n");
    const r = sanitizeText(input);
    expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r.text).not.toContain("alice@acmecorp.com");
    expect(r.text).not.toContain("172.16.254.1");
  });

  test("preserves non-secret content", () => {
    const input = "hello world, version 1.2.3, port 8080";
    const r = sanitizeText(input);
    expect(r.text).toBe(input);
    expect(r.replacements).toBe(0);
    expect(r.clean).toBe(true);
  });

  test("counts individual occurrences, not pattern classes", () => {
    const r = sanitizeText("alice@acmecorp.com and bob@acmecorp.com");
    expect(r.replacements).toBe(2);
  });

  test("passes through already-redacted text", () => {
    const input = "key = [REDACTED:aws-access-key]";
    const r = sanitizeText(input);
    expect(r.text).toBe(input);
  });
});

// ── sanitizeJsonPayload ────────────────────────────────────────────

describe("sanitizeJsonPayload", () => {
  test("sanitizes string values in objects", () => {
    const obj = {
      tokens: { github: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij" },
      data: "safe content",
    };
    const { sanitized, replacements } = sanitizeJsonPayload(obj);
    expect(replacements).toBeGreaterThan(0);
    const s = sanitized as { tokens: { github: string }; data: string };
    expect(s.tokens.github).toContain("[REDACTED:");
    expect(s.data).toBe("safe content");
  });

  test("sanitizes nested arrays", () => {
    const obj = { tokens: ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", "safe-value"] };
    const { sanitized } = sanitizeJsonPayload(obj);
    const s = sanitized as Record<string, string[]>;
    expect(s.tokens[0]).toContain("[REDACTED:");
    expect(s.tokens[1]).toBe("safe-value");
  });

  test("handles deeply nested structures", () => {
    const obj = { level1: { level2: { level3: { secret: "AKIAIOSFODNN7EXAMPLE" } } } };
    const { sanitized } = sanitizeJsonPayload(obj);
    const s = sanitized as { level1: { level2: { level3: { secret: string } } } };
    expect(s.level1.level2.level3.secret).toContain("[REDACTED:");
  });

  test("preserves non-string primitives", () => {
    const obj = { count: 42, active: true, empty: null };
    const { sanitized, replacements } = sanitizeJsonPayload(obj);
    expect(sanitized).toEqual(obj);
    expect(replacements).toBe(0);
  });

  test("handles empty objects and arrays", () => {
    expect(sanitizeJsonPayload({}).sanitized).toEqual({});
    expect(sanitizeJsonPayload([]).sanitized).toEqual([]);
  });

  test("deduplicates colliding sanitized keys instead of dropping values", () => {
    const obj = { "alice@acmecorp.com": 1, "bob@acmecorp.com": 2 };
    const { sanitized } = sanitizeJsonPayload(obj);
    const keys = Object.keys(sanitized as Record<string, unknown>);
    expect(keys.length).toBe(2);
    const values = Object.values(sanitized as Record<string, unknown>);
    expect(values).toContain(1);
    expect(values).toContain(2);
  });

  test("counts key replacements in the total", () => {
    const obj = { "alice@acmecorp.com": "safe-value" };
    const { replacements } = sanitizeJsonPayload(obj);
    expect(replacements).toBeGreaterThanOrEqual(1);
  });
});

// ── assertClean ────────────────────────────────────────────────────

describe("assertClean", () => {
  test("does not throw for clean text", () => {
    expect(() => assertClean("hello world, port 8080")).not.toThrow();
  });

  test("throws ResidualSecretError for dirty text", () => {
    expect(() => assertClean("key = AKIAIOSFODNN7EXAMPLE")).toThrow(ResidualSecretError);
  });

  test("error includes match details", () => {
    try {
      assertClean("AKIAIOSFODNN7EXAMPLE");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ResidualSecretError);
      const rse = err as ResidualSecretError;
      expect(rse.matches.length).toBeGreaterThan(0);
      expect(rse.matches[0].pattern).toBe("aws-access-key");
    }
  });
});

// ── Defence in depth: sanitize → re-scan ───────────────────────────

describe("defence in depth: sanitize then re-scan", () => {
  const DIRTY_INPUTS = [
    'Authorization: "Bearer sk-1234567890abcdefghijklmnop"',
    "AKIAIOSFODNN7EXAMPLE",
    "ASIAJEXAMPLEXEG456NY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    "github_pat_11ABCDEF0GHIJKLMNOPQRS_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012345678",
    "xoxb-1234567890-abcdefghij",
    "sk_live_TESTONLY00000000000000x",
    "alice@acmecorp.com",
    "172.16.254.1",
    "/Users/johndoe/secret/file",
    "-home-alice-project-foo",
    "mongodb://admin:pass123@mongo.internal:27017/prod",
    '"password": "hunter2-extended-edition"',
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
    "npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12",
    "pypi-AgEIcHlwaS5vcmcABCDEFGH12345",
    "sk-ant-api03-abcdefghijklmnopqrstuv",
    "glpat-ABCDEFghijklmnopqrstuv12",
    "AIzaSyA1234567890abcdefghijklmnopqrstuv",
    "hvs.ABCDEFghijklmnopqrstuv1234",
    "ATBB1234567890abcdefghijklmnopqrstuvwxyz",
    "fe80::",
    "2001:db8::1",
  ];

  for (const input of DIRTY_INPUTS) {
    test(`sanitize→re-scan is clean: ${input.slice(0, 50)}...`, () => {
      const r = sanitizeText(input);
      expect(r.clean).toBe(true);
      expect(() => assertClean(r.text)).not.toThrow();
    });
  }

  test("combined payload: all secrets in one blob", () => {
    const combined = DIRTY_INPUTS.join("\n");
    const r = sanitizeText(combined);
    expect(r.clean).toBe(true);
    expect(() => assertClean(r.text)).not.toThrow();
  });
});

// ── Negative tests: non-secrets pass through unchanged ─────────────

describe("negative tests: non-secrets pass through unchanged", () => {
  const SAFE_INPUTS = [
    "normal log message with no secrets",
    "version 2.1.119",
    "port 8080",
    "127.0.0.1:3000",
    "http://localhost:8080/api",
    "0.0.0.0:443",
    "test@example.com",
    "noreply@anthropic.com",
    "user@users.noreply.github.com",
    "/Users/Shared/data",
    "/home/runner/work/project",
    "255.255.255.0",
    "192.0.2.1",
    '{ "type": "init", "daemonId": "test-123" }',
    '{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }',
    "the Authorization flow requires a redirect",
    "AKIA followed by nothing special",
    "abc.def.ghi is not an IP",
    "Co-Authored-By: Claude <noreply@anthropic.com>",
    "password: ********",
    "[REDACTED:aws-access-key] already sanitized",
    "10.0.0.1",
    "e2b5eb6721f62f7b6da14bbab9ab9380cadc080c",
    "user@example.c|m is not a real email",
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "glpat- followed by nothing special",
    "AIza short",
    "::1",
    "::",
  ];

  for (const input of SAFE_INPUTS) {
    test(`passes through unchanged: ${input.slice(0, 60)}`, () => {
      const r = sanitizeText(input);
      expect(r.text).toBe(input);
    });
  }
});

// ── NDJSON recording line sanitization ─────────────────────────────

describe("NDJSON recording line sanitization", () => {
  test("sanitizes a realistic recording entry with secrets", () => {
    const entry = JSON.stringify({
      t: 1234567890,
      dir: "worker->daemon",
      kind: "control",
      payload: {
        type: "init",
        env: {
          GITHUB_TOKEN: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
          HOME: "/Users/johndoe/",
        },
      },
    });
    const r = sanitizeText(entry);
    expect(r.text).not.toContain("ghp_ABCDEF");
    expect(r.text).not.toContain("johndoe");
    expect(r.text).toContain("[REDACTED:");
    expect(r.clean).toBe(true);
  });

  test("preserves structure of clean recording entries", () => {
    const entry = JSON.stringify({
      t: 1234567890,
      dir: "daemon->worker",
      kind: "mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    const r = sanitizeText(entry);
    expect(r.text).toBe(entry);
    expect(r.clean).toBe(true);
  });
});
