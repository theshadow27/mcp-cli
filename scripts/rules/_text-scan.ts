/**
 * A small lexical scanner for check rules that must read ANOTHER file's structure. `ctx.ast()` only
 * parses the file under check, so a rule that looks across files (a spec for evidence, a worker for
 * its `switch` cases) reads those through the helpers here instead: comments are blanked, string
 * literals are kept, brackets are matched while skipping strings.
 *
 * Not a parser. It exists so that commented-out code and code in the wrong place stay invisible to
 * a cross-file rule, the way they were under the AST.
 */

/**
 * `src` with every comment replaced by spaces (newlines kept), so offsets and line numbers still
 * line up. String and template literals are left intact. A quote that never closes on its line is
 * treated as punctuation (an apostrophe in a regex literal), not as the start of a string.
 */
export function maskComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i] as string;
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      const stop = stringEnd(src, i);
      if (stop === -1) {
        out += ch;
        i++;
      } else {
        out += src.slice(i, stop);
        i = stop;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** The offset just past the string literal opening at `open`, or -1 if a quote line never closes it. */
function stringEnd(src: string, open: number): number {
  const quote = src[open] as string;
  for (let i = open + 1; i < src.length; i++) {
    const ch = src[i] as string;
    if (ch === "\\") i++;
    else if (ch === quote) return i + 1;
    else if (ch === "\n" && quote !== "`") return -1;
  }
  return -1;
}

const CLOSER: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** The offset of the bracket that closes the one at `open`, skipping string literals; -1 if none. */
export function matchingClose(src: string, open: number): number {
  const opener = src[open] as string;
  const closer = CLOSER[opener];
  if (closer === undefined) return -1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i] as string;
    if (ch === '"' || ch === "'" || ch === "`") {
      const stop = stringEnd(src, i);
      if (stop !== -1) i = stop - 1;
    } else if (ch === opener) depth++;
    else if (ch === closer && --depth === 0) return i;
  }
  return -1;
}

/** The values of the plain string literals (no `${}`) inside `src`, in order. */
export function stringLiteralValues(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const value = m[2] as string;
    if (m[1] === "`" && value.includes("${")) continue;
    out.push(value);
  }
  return out;
}
