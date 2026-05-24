export interface FlagSpec {
  type: "string" | "boolean" | "number";
  alias?: string;
  repeatable?: boolean;
}

export interface ParseResult {
  flags: Record<string, string | number | boolean | string[]>;
  positionals: string[];
  errors: string[];
  help: boolean;
}

// Returns true when token looks like a CLI flag (--flag or -f) that cannot be a value.
// Bare "-" (stdin sentinel) and negative numbers like "-5" are NOT flags.
function looksLikeFlag(token: string): boolean {
  if (token === "-") return false;
  if (token.startsWith("--")) return true;
  return /^-[A-Za-z]/.test(token);
}

// Validates a decimal number string (integer or float, with optional leading minus).
// Rejects empty, positive-sign prefix ("+5"), hex ("0x…"), scientific notation ("1e3"),
// Infinity, and non-numeric strings.
function parseDecimal(raw: string): number | null {
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  return Number(raw);
}

export function parseFlags(argv: string[], specs: Record<string, FlagSpec>): ParseResult {
  const flags: Record<string, string | number | boolean | string[]> = {};
  const positionals: string[] = [];
  const errors: string[] = [];
  let help = false;

  const byLong = new Map<string, { key: string; spec: FlagSpec }>();
  const byShort = new Map<string, { key: string; spec: FlagSpec }>();

  for (const [key, spec] of Object.entries(specs)) {
    if (spec.repeatable && spec.type !== "string") {
      throw new Error(`flag --${key}: repeatable is only supported for type "string"`);
    }
    byLong.set(`--${key}`, { key, spec });
    if (spec.alias) byShort.set(`-${spec.alias}`, { key, spec });
    if (spec.repeatable) flags[key] = [];
  }

  let stopFlags = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (stopFlags) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      stopFlags = true;
      continue;
    }

    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }

    if (token.startsWith("--") && token.includes("=")) {
      const eqIdx = token.indexOf("=");
      const flagPart = token.slice(0, eqIdx);
      const valuePart = token.slice(eqIdx + 1);
      const entry = byLong.get(flagPart);
      if (!entry) {
        errors.push(`unknown flag: ${flagPart}`);
        continue;
      }
      if (entry.spec.type === "boolean") {
        errors.push(`${flagPart} is a boolean flag and does not accept a value`);
        continue;
      }
      if (entry.spec.type === "number") {
        const n = parseDecimal(valuePart);
        if (n === null) {
          errors.push(`${flagPart} requires a numeric value, got "${valuePart}"`);
          continue;
        }
        flags[entry.key] = n;
      } else if (entry.spec.repeatable) {
        (flags[entry.key] as string[]).push(valuePart);
      } else {
        flags[entry.key] = valuePart;
      }
      continue;
    }

    const entry = byLong.get(token) ?? byShort.get(token);
    if (entry) {
      if (entry.spec.type === "boolean") {
        flags[entry.key] = true;
        continue;
      }

      const next = argv[i + 1];
      if (next === undefined || looksLikeFlag(next)) {
        errors.push(`${token} requires a value`);
        continue;
      }
      i++;

      if (entry.spec.type === "number") {
        const n = parseDecimal(next);
        if (n === null) {
          errors.push(`${token} requires a numeric value, got "${next}"`);
          continue;
        }
        flags[entry.key] = n;
      } else if (entry.spec.repeatable) {
        (flags[entry.key] as string[]).push(next);
      } else {
        flags[entry.key] = next;
      }
      continue;
    }

    if (looksLikeFlag(token)) {
      errors.push(`unknown flag: ${token}`);
      continue;
    }

    positionals.push(token);
  }

  return { flags, positionals, errors, help };
}
