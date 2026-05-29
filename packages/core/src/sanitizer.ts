import { homedir } from "node:os";

export interface SecretMatch {
  pattern: string;
  offset: number;
  length: number;
  matched: string;
}

export interface ScanResult {
  matches: SecretMatch[];
  clean: boolean;
}

export interface SanitizeResult {
  text: string;
  replacements: number;
  residualMatches: SecretMatch[];
  clean: boolean;
}

interface PatternDef {
  name: string;
  re: RegExp;
}

const ENV_KEY_NAMES = [
  "API_KEY",
  "API_SECRET",
  "SECRET_KEY",
  "ACCESS_KEY",
  "PRIVATE_KEY",
  "AUTH_TOKEN",
  "BEARER_TOKEN",
  "SESSION_TOKEN",
  "REFRESH_TOKEN",
  "CLIENT_SECRET",
  "ENCRYPTION_KEY",
  "SIGNING_KEY",
  "MASTER_KEY",
  "DATABASE_URL",
  "DATABASE_PASSWORD",
  "DB_PASSWORD",
  "REDIS_PASSWORD",
  "REDIS_URL",
  "MONGO_URI",
  "MONGODB_URI",
  "POSTGRES_PASSWORD",
  "MYSQL_PASSWORD",
];

const WELL_KNOWN_ENVS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET",
  "SLACK_TOKEN",
  "SLACK_BOT_TOKEN",
  "STRIPE_SECRET_KEY",
  "SENDGRID_API_KEY",
  "TWILIO_AUTH_TOKEN",
  "NPM_TOKEN",
  "SENTRY_DSN",
  "DATADOG_API_KEY",
  "NEWRELIC_LICENSE_KEY",
  "CLOUDFLARE_API_KEY",
  "HEROKU_API_KEY",
  "GITLAB_TOKEN",
  "BITBUCKET_TOKEN",
  "CODECOV_TOKEN",
  "SONAR_TOKEN",
  "DOCKER_PASSWORD",
  "PYPI_TOKEN",
  "NUGET_API_KEY",
  "SSH_PRIVATE_KEY",
];

function buildPatterns(): PatternDef[] {
  const suffixPattern = ENV_KEY_NAMES.map((k) => k.replace(/_/g, "[_-]")).join("|");
  const wellKnownPattern = WELL_KNOWN_ENVS.map((k) => k.replace(/_/g, "[_-]")).join("|");

  return [
    {
      name: "aws-access-key",
      re: /\bAKIA[0-9A-Z]{16}\b/g,
    },
    {
      name: "aws-secret-key",
      re: /\b[A-Za-z0-9/+=]{40}(?=\s|"|'|$)/gm,
    },
    {
      name: "jwt",
      re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    },
    {
      name: "authorization-header",
      re: /(?<=["']?(?:Authorization|authorization|Proxy-Authorization|proxy-authorization)["']?\s*[:=]\s*["']?)(?:Bearer |Basic |Token |token )?[A-Za-z0-9_/+\-.=]{20,}/g,
    },
    {
      name: "generic-api-key-header",
      re: /(?<=["']?(?:X-API-Key|x-api-key|X-Api-Key|api[_-]?key)["']?\s*[:=]\s*["']?)[A-Za-z0-9_/+\-.=]{16,}/g,
    },
    {
      name: "well-known-env",
      re: new RegExp(`(?<=${wellKnownPattern})["']?\\s*[:=]\\s*["']?([A-Za-z0-9_/+\\-.=]{8,})`, "gi"),
    },
    {
      name: "env-key-value",
      re: new RegExp(`(?:[A-Z_]*(?:${suffixPattern}))["']?\\s*[:=]\\s*["']?([A-Za-z0-9_/+\\-.=]{8,})`, "gi"),
    },
    {
      name: "private-key-block",
      re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    },
    {
      name: "github-token",
      re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
    },
    {
      name: "npm-token",
      re: /\bnpm_[A-Za-z0-9]{36,}\b/g,
    },
    {
      name: "slack-token",
      re: /\bxox[bpars]-[A-Za-z0-9\-]{10,}\b/g,
    },
    {
      name: "stripe-key",
      re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
    },
    {
      name: "email",
      re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    },
    {
      name: "ipv4",
      re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    },
    {
      name: "ipv6",
      re: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
    },
    {
      name: "ipv6-compressed",
      re: /\b(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}\b/g,
    },
    {
      name: "home-path",
      re: /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+\//g,
    },
    {
      name: "home-path-slug",
      re: /-Users-[A-Za-z0-9._-]+-/g,
    },
    {
      name: "connection-string",
      re: /\b(?:mongodb|postgres|postgresql|mysql|redis|amqp|amqps):\/\/[^\s"'`,;)}\]]+/gi,
    },
    {
      name: "generic-secret-assignment",
      re: /(?<=["']?(?:password|passwd|secret|credential|token)["']?\s*[:=]\s*["']?)[A-Za-z0-9_/+\-.=!@#$%^&*]{8,}/gi,
    },
  ];
}

let _patterns: PatternDef[] | null = null;
function getPatterns(): PatternDef[] {
  if (!_patterns) _patterns = buildPatterns();
  return _patterns;
}

export function scanSecrets(text: string): ScanResult {
  const matches: SecretMatch[] = [];

  for (const { name, re } of getPatterns()) {
    const pattern = new RegExp(re.source, re.flags);
    for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
      if (isKnownFalsePositive(name, m[0])) continue;
      matches.push({
        pattern: name,
        offset: m.index,
        length: m[0].length,
        matched: m[0],
      });
    }
  }

  return { matches, clean: matches.length === 0 };
}

const PLACEHOLDER_PREFIX = "[REDACTED";
const PLACEHOLDER_SUFFIX = "]";

function redactionPlaceholder(patternName: string): string {
  return `${PLACEHOLDER_PREFIX}:${patternName}${PLACEHOLDER_SUFFIX}`;
}

export function sanitizeText(text: string): SanitizeResult {
  let result = text;
  let replacements = 0;

  for (const { name, re } of getPatterns()) {
    const pattern = new RegExp(re.source, re.flags);
    const placeholder = redactionPlaceholder(name);
    let replaced = false;
    result = result.replace(pattern, (match) => {
      if (isKnownFalsePositive(name, match)) return match;
      replaced = true;
      return placeholder;
    });
    if (replaced) replacements++;
  }

  const residual = scanSecrets(result);
  return {
    text: result,
    replacements,
    residualMatches: residual.matches,
    clean: residual.clean,
  };
}

export function sanitizeJsonPayload(obj: unknown): { sanitized: unknown; replacements: number } {
  let total = 0;

  function walk(val: unknown): unknown {
    if (typeof val === "string") {
      const { text, replacements } = sanitizeText(val);
      total += replacements;
      return text;
    }
    if (Array.isArray(val)) {
      return val.map(walk);
    }
    if (val !== null && typeof val === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        const sanitizedKey = sanitizeText(k).text;
        out[sanitizedKey] = walk(v);
      }
      return out;
    }
    return val;
  }

  const sanitized = walk(obj);
  return { sanitized, replacements: total };
}

export class ResidualSecretError extends Error {
  constructor(public readonly matches: SecretMatch[]) {
    const summary = matches
      .slice(0, 5)
      .map((m) => `  ${m.pattern} at offset ${m.offset}`)
      .join("\n");
    super(`Residual secrets detected after sanitization:\n${summary}`);
    this.name = "ResidualSecretError";
  }
}

export function assertClean(text: string): void {
  const { matches, clean } = scanSecrets(text);
  if (!clean) {
    throw new ResidualSecretError(matches);
  }
}

const LOCALHOST_PATTERNS = /^(?:127\.0\.0\.\d+|0\.0\.0\.0|10\.0\.0\.\d+)$/;
const DOCUMENTATION_IPS = /^(?:192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/;
const EXAMPLE_DOMAINS = /^[^@]+@(?:example\.com|example\.org|test\.com|localhost)$/;

function isKnownFalsePositive(patternName: string, matched: string): boolean {
  if (patternName === "ipv4") {
    if (LOCALHOST_PATTERNS.test(matched)) return true;
    if (DOCUMENTATION_IPS.test(matched)) return true;
    if (matched === "255.255.255.0" || matched === "255.255.255.255") return true;
    if (/^\d+\.\d+\.\d+$/.test(matched)) return true;
  }

  if (patternName === "email") {
    if (EXAMPLE_DOMAINS.test(matched)) return true;
    if (matched.endsWith("@users.noreply.github.com")) return true;
    if (matched === "noreply@anthropic.com") return true;
  }

  if (patternName === "home-path") {
    if (matched === "/Users/Shared/" || matched === "/home/runner/") return true;
  }

  if (patternName === "aws-secret-key") {
    if (/^[A-Za-z]+$/.test(matched)) return true;
    if (/^[0-9]+$/.test(matched)) return true;
    if (matched.length < 40) return true;
  }

  if (patternName === "generic-secret-assignment") {
    if (/^\*+$/.test(matched)) return true;
    if (/^\[REDACTED/.test(matched)) return true;
  }

  return false;
}

export function sanitizeForRecording(ndjsonLine: string): SanitizeResult {
  return sanitizeText(ndjsonLine);
}

export function buildHomePath(): string {
  return homedir();
}
