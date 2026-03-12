/**
 * Converts Python repr strings to valid JSON.
 *
 * Handles: single-quoted strings, True/False/None, tuple syntax (,) → arrays,
 * nested structures, and Python string prefixes (b'', r'', u'', f'', br'', etc.).
 * Uses a character-level tokenizer to avoid regex pitfalls with embedded quotes
 * (e.g., `{'msg': "it's broken"}`).
 *
 * Limitations:
 * - Octal escapes (\177) are not converted and will produce invalid JSON.
 */

const KEYWORD_MAP: Record<string, string> = {
  True: "true",
  False: "false",
  None: "null",
};

/**
 * Convert a Python repr string to its JSON equivalent.
 * Returns the original value if it's not a string or can't be converted.
 */
export function parsePythonRepr(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;

  const trimmed = raw.trim();
  if (!trimmed) return raw;

  // Fast path: try JSON.parse first — if it's already valid JSON, skip conversion
  try {
    return JSON.parse(trimmed);
  } catch {
    // not valid JSON, attempt Python repr conversion
  }

  try {
    const json = pythonReprToJson(trimmed);
    return JSON.parse(json);
  } catch {
    return raw;
  }
}

/**
 * Convert Python repr string to a JSON string via character-level tokenization.
 */
export function pythonReprToJson(input: string): string {
  const out: string[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];

    // Whitespace — pass through
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      out.push(ch);
      i++;
      continue;
    }

    // String prefix detection — b'', r'', f'', u'', br'', rb'', fr'', rf'', etc.
    // Must be checked before the word handler to avoid emitting the prefix as a bare word.
    const prefix = tryStringPrefix(input, i, len);
    if (prefix) {
      i = prefix.quotePos;
      // Fall through — i now points at the quote, handled below
    }

    const isRaw = prefix?.isRaw ?? false;

    // Single-quoted string → double-quoted JSON string
    if (input[i] === "'") {
      i++;
      const str: string[] = [];
      while (i < len && input[i] !== "'") {
        if (input[i] === "\\") {
          if (isRaw) {
            // Raw strings: backslashes are literal, except \' which ends the string
            if (i + 1 < len && input[i + 1] === "'") {
              // \' in raw string — literal apostrophe
              str.push("'");
              i += 2;
            } else {
              // Literal backslash — must be escaped for JSON
              str.push("\\\\");
              i++;
            }
            continue;
          }
          i++;
          if (i >= len) break;
          const esc = input[i];
          if (esc === "'") {
            // Python \' → literal '
            str.push("'");
          } else if (esc === '"') {
            // Python \" → escaped quote in JSON
            str.push('\\"');
          } else if (esc === "\\") {
            str.push("\\\\");
          } else if (esc === "n") {
            str.push("\\n");
          } else if (esc === "r") {
            str.push("\\r");
          } else if (esc === "t") {
            str.push("\\t");
          } else if (esc === "b") {
            str.push("\\b");
          } else if (esc === "f") {
            str.push("\\f");
          } else if (esc === "x") {
            // \xNN → \u00NN
            const hex = input.substring(i + 1, i + 3);
            if (hex.length === 2 && /^[0-9a-fA-F]{2}$/.test(hex)) {
              str.push("\\u00");
              str.push(hex);
              i += 2;
            } else {
              str.push("\\u0078"); // literal 'x'
            }
          } else if (esc === "U") {
            // \UNNNNNNNN → \uNNNN (BMP) or surrogate pair
            const hex = input.substring(i + 1, i + 9);
            if (hex.length === 8 && /^[0-9a-fA-F]{8}$/.test(hex)) {
              const cp = Number.parseInt(hex, 16);
              if (cp <= 0xffff) {
                str.push(`\\u${hex.slice(4)}`);
              } else if (cp <= 0x10ffff) {
                // Surrogate pair
                const offset = cp - 0x10000;
                const hi = 0xd800 + (offset >> 10);
                const lo = 0xdc00 + (offset & 0x3ff);
                str.push(`\\u${hi.toString(16).padStart(4, "0")}`);
                str.push(`\\u${lo.toString(16).padStart(4, "0")}`);
              } else {
                str.push("\\u0055"); // literal 'U' for out-of-range
              }
              i += 8;
            } else {
              str.push("\\u0055"); // literal 'U'
            }
          } else if (esc === "u") {
            // \uNNNN — valid in JSON, pass through
            str.push("\\u");
          } else if (esc === "0") {
            str.push("\\u0000");
          } else if (esc === "a") {
            str.push("\\u0007"); // BEL
          } else if (esc === "v") {
            str.push("\\u000b"); // VT
          } else {
            // Unknown escape — emit the character literally (drop the backslash)
            // This handles octal and other Python-specific escapes gracefully
            str.push(esc);
          }
        } else if (input[i] === '"') {
          // Unescaped double quote inside single-quoted string must be escaped for JSON
          str.push('\\"');
        } else {
          str.push(input[i]);
        }
        i++;
      }
      i++; // skip closing '
      out.push('"');
      out.push(str.join(""));
      out.push('"');
      continue;
    }

    // Double-quoted string — pass through (already JSON-compatible)
    // Note: uses input[i] not ch, because prefix detection may have advanced i
    if (input[i] === '"') {
      out.push('"');
      i++;
      while (i < len && input[i] !== '"') {
        if (input[i] === "\\") {
          if (isRaw) {
            // Raw strings: backslashes are literal
            out.push("\\\\");
            i++;
          } else {
            out.push(input[i]);
            i++;
            if (i < len) {
              out.push(input[i]);
              i++;
            }
          }
        } else {
          out.push(input[i]);
          i++;
        }
      }
      if (i < len) {
        out.push('"');
        i++;
      }
      continue;
    }

    // Python tuples: ( ) → [ ]
    if (ch === "(") {
      out.push("[");
      i++;
      continue;
    }
    if (ch === ")") {
      // Remove trailing comma before closing bracket (Python trailing comma in tuples)
      trimTrailingComma(out);
      out.push("]");
      i++;
      continue;
    }

    // Closing braces/brackets — trim trailing commas before emitting
    if (ch === "}" || ch === "]") {
      trimTrailingComma(out);
      out.push(ch);
      i++;
      continue;
    }

    // Structural characters — pass through
    if (ch === "{" || ch === "[" || ch === ":" || ch === ",") {
      out.push(ch);
      i++;
      continue;
    }

    // Keywords (True, False, None) and numbers
    if (isWordChar(ch) || ch === "-" || ch === "+") {
      const start = i;
      // Allow leading sign for numbers — but only if followed by digit/dot
      if ((ch === "-" || ch === "+") && i + 1 < len && (isDigit(input[i + 1]) || input[i + 1] === ".")) {
        i++;
      }
      while (i < len && (isWordChar(input[i]) || input[i] === ".")) {
        i++;
      }
      // If no progress was made (bare +/- with no digits), emit the character and advance
      if (i === start) {
        out.push(ch);
        i++;
        continue;
      }
      const word = input.substring(start, i);

      const mapped = KEYWORD_MAP[word];
      if (mapped !== undefined) {
        out.push(mapped);
      } else {
        // Numbers or other literals — pass through
        out.push(word);
      }
      continue;
    }

    // Anything else — pass through
    out.push(ch);
    i++;
  }

  return out.join("");
}

const STRING_PREFIX_CHARS = new Set(["b", "B", "r", "R", "u", "U", "f", "F"]);

/**
 * Check if position `i` starts a Python string prefix (b, r, u, f, br, rb, fr, rf, etc.)
 * immediately followed by a quote character (' or ").
 * Returns the quote position and whether it's a raw string, or null if not a prefix.
 */
function tryStringPrefix(input: string, i: number, len: number): { quotePos: number; isRaw: boolean } | null {
  if (i >= len || !STRING_PREFIX_CHARS.has(input[i])) return null;

  const c1 = input[i];
  // Two-character prefix (br, rb, fr, rf)
  if (i + 2 < len && STRING_PREFIX_CHARS.has(input[i + 1])) {
    const c2 = input[i + 1];
    const quote = input[i + 2];
    if (quote === "'" || quote === '"') {
      const pair = (c1 + c2).toLowerCase();
      // Valid two-char prefixes: br, rb, fr, rf
      if (pair === "br" || pair === "rb" || pair === "fr" || pair === "rf") {
        return { quotePos: i + 2, isRaw: pair.includes("r") };
      }
    }
  }
  // Single-character prefix
  if (i + 1 < len) {
    const quote = input[i + 1];
    if (quote === "'" || quote === '"') {
      return { quotePos: i + 1, isRaw: c1 === "r" || c1 === "R" };
    }
  }
  return null;
}

function isWordChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_";
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function trimTrailingComma(out: string[]): void {
  // Walk backwards over whitespace to find and remove a trailing comma
  for (let j = out.length - 1; j >= 0; j--) {
    const s = out[j];
    if (s === " " || s === "\t" || s === "\n" || s === "\r") continue;
    if (s === ",") {
      out.splice(j, 1);
    }
    break;
  }
}
