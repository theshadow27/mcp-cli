import { describe, expect, test } from "bun:test";
import {
  ResidualSecretError,
  type SanitizeResult,
  assertClean,
  sanitizeJsonPayload,
  sanitizeText,
  scanSecrets,
} from "./sanitizer";

describe("scanSecrets", () => {
  describe("AWS keys", () => {
    test("detects AWS access key IDs", () => {
      const result = scanSecrets("key = AKIAIOSFODNN7EXAMPLE");
      expect(result.clean).toBe(false);
      expect(result.matches.some((m) => m.pattern === "aws-access-key")).toBe(true);
    });

    test("ignores partial AKIA prefix without full length", () => {
      const result = scanSecrets("AKIA_SHORT");
      expect(result.matches.some((m) => m.pattern === "aws-access-key")).toBe(false);
    });

    test("ignores git SHA-1 hashes (40 hex chars)", () => {
      const result = scanSecrets("commit e2b5eb6721f62f7b6da14bbab9ab9380cadc080c");
      expect(result.matches.some((m) => m.pattern === "aws-secret-key")).toBe(false);
    });

    test("ignores SHA-1 of empty string (all hex)", () => {
      const result = scanSecrets("da39a3ee5e6b4b0d3255bfef95601890afd80709");
      expect(result.matches.some((m) => m.pattern === "aws-secret-key")).toBe(false);
    });
  });

  describe("JWTs", () => {
    test("detects JWT tokens", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
      const result = scanSecrets(`token: ${jwt}`);
      expect(result.clean).toBe(false);
      expect(result.matches.some((m) => m.pattern === "jwt")).toBe(true);
    });

    test("ignores strings that look JWT-ish but have only two segments", () => {
      const result = scanSecrets("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0");
      expect(result.matches.some((m) => m.pattern === "jwt")).toBe(false);
    });
  });

  describe("Authorization headers", () => {
    test("detects Bearer token in header", () => {
      const result = scanSecrets('"Authorization": "Bearer sk-1234567890abcdefghijk"');
      expect(result.clean).toBe(false);
      expect(result.matches.some((m) => m.pattern === "authorization-header")).toBe(true);
    });

    test("detects Basic auth in header", () => {
      const result = scanSecrets('"Authorization": "Basic dXNlcjpwYXNzd29yZDEyMzQ1"');
      expect(result.clean).toBe(false);
      expect(result.matches.some((m) => m.pattern === "authorization-header")).toBe(true);
    });

    test("does not flag the word Authorization in prose", () => {
      const result = scanSecrets("The Authorization flow requires a redirect");
      expect(result.matches.some((m) => m.pattern === "authorization-header")).toBe(false);
    });
  });

  describe("API key headers", () => {
    test("detects X-API-Key header value", () => {
      const result = scanSecrets('"X-API-Key": "abcdef1234567890abcdef"');
      expect(result.clean).toBe(false);
      expect(result.matches.some((m) => m.pattern === "generic-api-key-header")).toBe(true);
    });
  });

  describe("environment variable secrets", () => {
    test("detects GITHUB_TOKEN assignment", () => {
      const result = scanSecrets("GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1234");
      expect(result.clean).toBe(false);
    });

    test("detects API_KEY in JSON", () => {
      const result = scanSecrets('{"API_KEY": "super-secret-key-value-1234"}');
      expect(result.clean).toBe(false);
    });

    test("detects DATABASE_URL with credentials", () => {
      const result = scanSecrets("DATABASE_URL=postgres://user:password123@host:5432/db");
      expect(result.clean).toBe(false);
    });

    test("detects CLIENT_SECRET", () => {
      const result = scanSecrets('"CLIENT_SECRET": "a1b2c3d4e5f6g7h8i9j0klmn"');
      expect(result.clean).toBe(false);
    });

    test("detects ANTHROPIC_API_KEY", () => {
      const result = scanSecrets("ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxx");
      expect(result.clean).toBe(false);
    });

    test("preserves key name when sanitizing env-key-value", () => {
      const result = sanitizeText('"API_KEY": "super-secret-key-value-1234"');
      expect(result.text).toContain("API_KEY");
      expect(result.text).toContain("[REDACTED:");
      expect(result.text).not.toContain("super-secret");
    });

    test("preserves key name when sanitizing well-known-env", () => {
      const result = sanitizeText("GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1234");
      expect(result.text).toContain("GITHUB_TOKEN=");
      expect(result.text).toContain("[REDACTED:");
      expect(result.text).not.toContain("ghp_");
    });

    test("preserves separator when sanitizing well-known-env with JSON", () => {
      const result = sanitizeText('"ANTHROPIC_API_KEY": "sk-ant-xxxxxxxxxxxxxxxxxxxx"');
      expect(result.text).toContain("ANTHROPIC_API_KEY");
      expect(result.text).toContain("[REDACTED:");
    });
  });

  describe("GitHub tokens", () => {
    test("detects ghp_ personal access token", () => {
      const result = scanSecrets("token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij");
      expect(result.clean).toBe(false);
      expect(result.matches.some((m) => m.pattern === "github-token")).toBe(true);
    });

    test("detects gho_ OAuth token", () => {
      const result = scanSecrets("gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij");
      expect(result.clean).toBe(false);
    });

    test("detects ghs_ server-to-server token", () => {
      const result = scanSecrets("ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij");
      expect(result.clean).toBe(false);
    });
  });

  describe("npm tokens", () => {
    test("detects npm_ token", () => {
      const result = scanSecrets("npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12");
      expect(result.clean).toBe(false);
      expect(result.matches.some((m) => m.pattern === "npm-token")).toBe(true);
    });
  });

  describe("Slack tokens", () => {
    test("detects xoxb- bot token", () => {
      const result = scanSecrets("xoxb-1234567890-abcdefghij");
      expect(result.clean).toBe(false);
      expect(result.matches.some((m) => m.pattern === "slack-token")).toBe(true);
    });

    test("detects xoxp- user token", () => {
      const result = scanSecrets("xoxp-1234567890-abcdefghij");
      expect(result.clean).toBe(false);
    });
  });

  describe("Stripe keys", () => {
    test("detects sk_live_ secret key", () => {
      const result = scanSecrets("sk_live_TESTONLY00000000000000x");
      expect(result.clean).toBe(false);
      expect(result.matches.some((m) => m.pattern === "stripe-key")).toBe(true);
    });

    test("detects sk_test_ test key", () => {
      const result = scanSecrets("sk_test_TESTONLY00000000000000x");
      expect(result.clean).toBe(false);
    });
  });

  describe("private key blocks", () => {
    test("detects RSA private key", () => {
      const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
      const result = scanSecrets(key);
      expect(result.clean).toBe(false);
      expect(result.matches.some((m) => m.pattern === "private-key-block")).toBe(true);
    });

    test("detects generic private key block", () => {
      const key = "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----";
      const result = scanSecrets(key);
      expect(result.clean).toBe(false);
    });
  });

  describe("emails", () => {
    test("detects email addresses", () => {
      const result = scanSecrets("contact: alice.smith@acmecorp.com");
      expect(result.clean).toBe(false);
      expect(result.matches.some((m) => m.pattern === "email")).toBe(true);
    });

    test("allows example.com emails (false positive)", () => {
      const result = scanSecrets("test@example.com");
      expect(result.matches.some((m) => m.pattern === "email")).toBe(false);
    });

    test("allows noreply@anthropic.com", () => {
      const result = scanSecrets("Co-Authored-By: Claude <noreply@anthropic.com>");
      expect(result.matches.some((m) => m.pattern === "email")).toBe(false);
    });

    test("allows GitHub noreply addresses", () => {
      const result = scanSecrets("user@users.noreply.github.com");
      expect(result.matches.some((m) => m.pattern === "email")).toBe(false);
    });
  });

  describe("IP addresses", () => {
    test("detects IPv4 addresses", () => {
      const result = scanSecrets("server: 172.16.254.1");
      expect(result.clean).toBe(false);
      expect(result.matches.some((m) => m.pattern === "ipv4")).toBe(true);
    });

    test("detects IPv6 addresses", () => {
      const result = scanSecrets("addr: 2001:0db8:85a3:0000:0000:8a2e:0370:7334");
      expect(result.clean).toBe(false);
      expect(result.matches.some((m) => m.pattern === "ipv6")).toBe(true);
    });

    test("allows localhost 127.0.0.1", () => {
      const result = scanSecrets("bind: 127.0.0.1");
      expect(result.matches.some((m) => m.pattern === "ipv4")).toBe(false);
    });

    test("allows 0.0.0.0", () => {
      const result = scanSecrets("listen: 0.0.0.0");
      expect(result.matches.some((m) => m.pattern === "ipv4")).toBe(false);
    });

    test("allows 10.0.0.x range", () => {
      const result = scanSecrets("bind: 10.0.0.1");
      expect(result.matches.some((m) => m.pattern === "ipv4")).toBe(false);
    });

    test("allows subnet masks", () => {
      const result = scanSecrets("mask: 255.255.255.0");
      expect(result.matches.some((m) => m.pattern === "ipv4")).toBe(false);
    });

    test("allows RFC 5737 documentation IPs", () => {
      const result = scanSecrets("example: 192.0.2.1 and 198.51.100.1 and 203.0.113.1");
      expect(result.matches.some((m) => m.pattern === "ipv4")).toBe(false);
    });
  });

  describe("home paths", () => {
    test("detects /Users/<name>/ paths", () => {
      const result = scanSecrets("path: /Users/johndoe/projects/secret");
      expect(result.clean).toBe(false);
      expect(result.matches.some((m) => m.pattern === "home-path")).toBe(true);
    });

    test("detects /home/<name>/ paths", () => {
      const result = scanSecrets("path: /home/ubuntu/.ssh/id_rsa");
      expect(result.clean).toBe(false);
    });

    test("detects Claude-style slug paths (macOS)", () => {
      const result = scanSecrets("dir: -Users-johndoe-projects");
      expect(result.clean).toBe(false);
      expect(result.matches.some((m) => m.pattern === "home-path-slug")).toBe(true);
    });

    test("detects Linux home slug paths (-home-alice-)", () => {
      const result = scanSecrets("dir: -home-alice-project-foo");
      expect(result.clean).toBe(false);
      expect(result.matches.some((m) => m.pattern === "home-path-slug")).toBe(true);
    });

    test("allows /Users/Shared/", () => {
      const result = scanSecrets("/Users/Shared/data");
      expect(result.matches.some((m) => m.pattern === "home-path")).toBe(false);
    });

    test("allows /home/runner/ (CI)", () => {
      const result = scanSecrets("/home/runner/work/project");
      expect(result.matches.some((m) => m.pattern === "home-path")).toBe(false);
    });
  });

  describe("connection strings", () => {
    test("detects MongoDB URI", () => {
      const result = scanSecrets("mongodb://admin:password@host:27017/db");
      expect(result.clean).toBe(false);
      expect(result.matches.some((m) => m.pattern === "connection-string")).toBe(true);
    });

    test("detects PostgreSQL URI", () => {
      const result = scanSecrets("postgres://user:pass@host:5432/mydb");
      expect(result.clean).toBe(false);
    });

    test("detects Redis URI", () => {
      const result = scanSecrets("redis://default:secretpass@redis.example.com:6379");
      expect(result.clean).toBe(false);
    });
  });

  describe("generic secret assignments", () => {
    test("detects password assignment", () => {
      const result = scanSecrets('"password": "hunter2-extended-edition"');
      expect(result.clean).toBe(false);
    });

    test("detects secret assignment", () => {
      const result = scanSecrets('"secret": "my-super-secret-value-123"');
      expect(result.clean).toBe(false);
    });

    test("does not flag masked passwords (****)", () => {
      const result = scanSecrets('"password": "********"');
      expect(result.matches.some((m) => m.pattern === "generic-secret-assignment")).toBe(false);
    });
  });
});

describe("sanitizeText", () => {
  test("replaces secrets with redaction placeholders", () => {
    const input = "key = AKIAIOSFODNN7EXAMPLE and done";
    const result = sanitizeText(input);
    expect(result.text).toContain("[REDACTED:aws-access-key]");
    expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.replacements).toBeGreaterThan(0);
  });

  test("replaces JWT tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = sanitizeText(`Authorization: Bearer ${jwt}`);
    expect(result.text).toContain("[REDACTED:");
    expect(result.text).not.toContain("eyJhbGci");
  });

  test("replaces home paths", () => {
    const result = sanitizeText("working in /Users/johndoe/code/project");
    expect(result.text).toContain("[REDACTED:home-path]");
    expect(result.text).not.toContain("johndoe");
  });

  test("replaces emails", () => {
    const result = sanitizeText("from alice.smith@acmecorp.com");
    expect(result.text).toContain("[REDACTED:email]");
    expect(result.text).not.toContain("alice.smith@acmecorp.com");
  });

  test("replaces multiple different secret types", () => {
    const input = ["key = AKIAIOSFODNN7EXAMPLE", "email: alice@acmecorp.com", "server: 172.16.254.1"].join("\n");
    const result = sanitizeText(input);
    expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.text).not.toContain("alice@acmecorp.com");
    expect(result.text).not.toContain("172.16.254.1");
  });

  test("preserves non-secret content", () => {
    const input = "hello world, version 1.2.3, port 8080";
    const result = sanitizeText(input);
    expect(result.text).toBe(input);
    expect(result.replacements).toBe(0);
    expect(result.clean).toBe(true);
  });

  test("counts individual occurrences, not pattern classes", () => {
    const input = "alice@acmecorp.com and bob@acmecorp.com";
    const result = sanitizeText(input);
    expect(result.replacements).toBe(2);
  });

  test("passes through already-redacted text", () => {
    const input = "key = [REDACTED:aws-access-key]";
    const result = sanitizeText(input);
    expect(result.text).toBe(input);
  });
});

describe("sanitizeJsonPayload", () => {
  test("sanitizes string values in objects", () => {
    const obj = {
      tokens: {
        github: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
      },
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
    const obj = {
      level1: {
        level2: {
          level3: {
            secret: "AKIAIOSFODNN7EXAMPLE",
          },
        },
      },
    };
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

  test("counts key replacements in the total", () => {
    const obj = { "alice@acmecorp.com": "safe-value" };
    const { replacements } = sanitizeJsonPayload(obj);
    expect(replacements).toBeGreaterThanOrEqual(1);
  });
});

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

describe("defence in depth: sanitize then re-scan", () => {
  const DIRTY_INPUTS = [
    'Authorization: "Bearer sk-1234567890abcdefghijklmnop"',
    "AKIAIOSFODNN7EXAMPLE",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
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
  ];

  for (const input of DIRTY_INPUTS) {
    test(`sanitize→re-scan is clean: ${input.slice(0, 50)}...`, () => {
      const result = sanitizeText(input);
      expect(result.clean).toBe(true);
      expect(() => assertClean(result.text)).not.toThrow();
    });
  }

  test("combined payload: all secrets in one blob", () => {
    const combined = DIRTY_INPUTS.join("\n");
    const result = sanitizeText(combined);
    expect(result.clean).toBe(true);
    expect(() => assertClean(result.text)).not.toThrow();
  });
});

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
  ];

  for (const input of SAFE_INPUTS) {
    test(`passes through unchanged: ${input.slice(0, 60)}`, () => {
      const result = sanitizeText(input);
      expect(result.text).toBe(input);
    });
  }
});

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
    const result = sanitizeText(entry);
    expect(result.text).not.toContain("ghp_ABCDEF");
    expect(result.text).not.toContain("johndoe");
    expect(result.text).toContain("[REDACTED:");
    expect(result.clean).toBe(true);
  });

  test("preserves structure of clean recording entries", () => {
    const entry = JSON.stringify({
      t: 1234567890,
      dir: "daemon->worker",
      kind: "mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    const result = sanitizeText(entry);
    expect(result.text).toBe(entry);
    expect(result.clean).toBe(true);
  });
});
