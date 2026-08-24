/**
 * Card frontmatter model: parsing, typed reads, and the surgical single-line write.
 *
 * A card is a markdown file with YAML frontmatter — one file per thing (docs/cards.md).
 * Ported from `scripts/sprint/model.ts` in `phoenix-octovalve@feat/sprint-loop`
 * (theshadow27/phoenix-octovalve#1242), trimmed to the part that is generic across every
 * card kind. That source file also carried item/decision/feedback-specific types, the
 * fail-closed selection predicates, and `current.json`/loop-state — those are sprint-loop's
 * own concepts, not cards'. mcx's cards are kind-open (`.mcx.yaml` declares kinds per
 * domain), so this module stops at the layer every kind shares: frontmatter in, frontmatter
 * out. Kinds/statuses (#3067), the fail-closed predicates (#3068), and staleness (#3069)
 * layer on top in their own modules.
 *
 * **Reads parse YAML; writes do line surgery.** `Bun.YAML.parse` gives typed reads, but a
 * parse/stringify round trip would reflow every hand-written card and bury real changes in
 * whitespace noise. `setFrontmatter` therefore edits the one line it was asked to edit and
 * leaves the rest of the file — comments, key order, prose, trailing whitespace — byte
 * identical. These files are meant to be hand-edited by a person as often as they are
 * written by a tool.
 *
 * Nothing here touches the filesystem — that is `card-store.ts`'s job. Parsing and
 * rendering are pure so they can be exercised on strings.
 */

/** A card as it sits on disk: its path, its parsed frontmatter, and everything after it. */
export interface Card {
  /** Path as given to {@link parseCard} — a store-relative or absolute path, for error messages. */
  path: string;
  /** Parsed frontmatter. Empty when the file has none — `check`-style tooling reports that; parsing doesn't throw. */
  front: Record<string, unknown>;
  /** Raw frontmatter text, without the `---` fences. */
  frontText: string;
  /** Everything after the closing fence. */
  body: string;
  /** Set when the frontmatter block exists but does not parse. */
  parseError?: string;
}

const FENCE = "---";

/**
 * Split a document into its frontmatter block and body.
 * A file with no leading fence is all body — never an error, because a half-written card
 * should still be readable by the tools that are about to complain about it.
 */
export function splitFrontmatter(text: string): { frontText: string | null; body: string } {
  const normalized = text.startsWith("﻿") ? text.slice(1) : text;
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== FENCE) return { frontText: null, body: normalized };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE);
  if (end === -1) return { frontText: null, body: normalized };
  return {
    frontText: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n"),
  };
}

/** Parse a card. Never throws: a bad YAML block becomes `parseError` for callers to report. */
export function parseCard(path: string, text: string): Card {
  const { frontText, body } = splitFrontmatter(text);
  if (frontText === null) return { path, front: {}, frontText: "", body };
  try {
    const parsed: unknown = Bun.YAML.parse(frontText);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { path, front: {}, frontText, body, parseError: "frontmatter is not a mapping" };
    }
    return { path, front: parsed as Record<string, unknown>, frontText, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { path, front: {}, frontText, body, parseError: message };
  }
}

/** A scalar we are willing to write back into frontmatter. */
export type Scalar = string | number | boolean | null;

/** Render a scalar the way YAML wants it, quoting only when the value would otherwise reparse wrong. */
export function renderScalar(value: Scalar): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === "") return '""';
  // `\s#` matters more than it looks: `actioned-as: PR #1241` parses as the string "PR"
  // with a comment, which silently loses the PR number the whole card exists to record.
  //
  // `^[-+.0-9]` is the same loss, one Bun version later. An unquoted scalar that *opens*
  // like a number is at the mercy of the reader's scalar resolver: `id: 24-1120` comes back
  // as the string under Bun 1.4 and as the number `24` under 1.3.14 — so a check that
  // passed on one box failed in CI, on identical bytes. Quoting anything that opens with a
  // digit or a sign settles it in the file instead of trusting every reader to agree.
  // Values written *as* numbers are unaffected; they returned above.
  const needsQuote = /^[\s>|&*!%@`#{}[\],'"]|^[-+.0-9]|:\s|\s#|\s$|[\n\r]|^(?:true|false|null|yes|no|on|off|~)$/i.test(
    value,
  );
  return needsQuote ? JSON.stringify(value) : value;
}

/** Render a list value inline: `[a, b]`, or `[]` when empty. */
export function renderList(values: readonly string[]): string {
  return `[${values.map((value) => renderScalar(value)).join(", ")}]`;
}

/**
 * Set one frontmatter key, in place, preserving every other byte of the file.
 *
 * Appends the key at the end of the block when it is absent. A document with no
 * frontmatter at all gets one — that is the only case where this function reflows
 * anything.
 */
export function setFrontmatter(text: string, key: string, rendered: string): string {
  const { frontText, body } = splitFrontmatter(text);
  if (frontText === null) return `${[FENCE, `${key}: ${rendered}`, FENCE].join("\n")}\n${text}`;
  const lines = frontText.split("\n");
  const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
  const index = lines.findIndex((line) => pattern.test(line));
  const next = `${key}: ${rendered}`;
  const updated = index === -1 ? [...lines, next] : lines.map((line, i) => (i === index ? next : line));
  // The body keeps its own leading newline — stripping it would silently eat the blank line
  // that almost every card has between the closing fence and its heading.
  return `${[FENCE, ...updated, FENCE].join("\n")}\n${body}`;
}

// ============================================================================
// Typed reads — forgiving by design; kind-specific lint tooling is where wrongness gets reported
// ============================================================================

export function readString(front: Record<string, unknown>, key: string): string | undefined {
  const value = front[key];
  if (typeof value === "string") return value.trim() === "" ? undefined : value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}

export function readNumber(front: Record<string, unknown>, key: string): number | undefined {
  const value = front[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/**
 * Read a list of strings. Accepts a YAML list, a bare scalar (one-element list), or a
 * comma-separated string, because all three get typed by hand and all three mean the same thing.
 */
export function readList(front: Record<string, unknown>, key: string): string[] {
  const value = front[key];
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string | number => typeof entry === "string" || typeof entry === "number")
      .map((entry) => String(entry).trim())
      .filter((entry) => entry !== "");
  }
  if (typeof value === "number") return [String(value)];
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
  }
  return [];
}

/** Read an enum-typed field, case-insensitively matched against `allowed`. */
export function readEnum<T extends string>(
  front: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const raw = readString(front, key);
  if (raw === undefined) return undefined;
  return allowed.find((candidate) => candidate.toLowerCase() === raw.toLowerCase());
}

/** The first markdown heading, or `fallback` — what a one-line listing shows. */
export function titleOf(card: Card, fallback: string): string {
  for (const line of card.body.split("\n")) {
    const match = /^#{1,3}\s+(.*\S)\s*$/.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return fallback;
}

/** `01-foley-emails-optin.md` → `01-foley-emails-optin`. */
export function idFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}
