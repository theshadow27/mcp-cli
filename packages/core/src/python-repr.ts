/**
 * Converts Python repr strings to valid JSON.
 *
 * Handles: single-quoted strings, True/False/None, tuple syntax (,) → arrays,
 * nested structures. Uses a character-level tokenizer to avoid regex pitfalls
 * with embedded quotes (e.g., `{'msg': "it's broken"}`).
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

    // Single-quoted string → double-quoted JSON string
    if (ch === "'") {
      i++;
      const str: string[] = [];
      while (i < len && input[i] !== "'") {
        if (input[i] === "\\") {
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
          } else if (esc === "u" || esc === "U" || esc === "x") {
            str.push("\\");
            str.push(esc);
          } else {
            str.push("\\");
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
    if (ch === '"') {
      out.push('"');
      i++;
      while (i < len && input[i] !== '"') {
        if (input[i] === "\\") {
          out.push(input[i]);
          i++;
          if (i < len) {
            out.push(input[i]);
            i++;
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

    // Structural characters — pass through
    if (ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === ":" || ch === ",") {
      out.push(ch);
      i++;
      continue;
    }

    // Keywords (True, False, None) and numbers
    if (isWordChar(ch) || ch === "-" || ch === "+") {
      const start = i;
      // Allow leading sign for numbers
      if ((ch === "-" || ch === "+") && i + 1 < len && (isDigit(input[i + 1]) || input[i + 1] === ".")) {
        i++;
      }
      while (i < len && (isWordChar(input[i]) || input[i] === ".")) {
        i++;
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
