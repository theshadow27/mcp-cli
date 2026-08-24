/**
 * Card store — where a domain's cards live, and the read/write primitives over them.
 *
 * Ported (the store half) from `scripts/sprint/store.ts` in
 * `phoenix-octovalve@feat/sprint-loop` (theshadow27/phoenix-octovalve#1242), trimmed to
 * what is generic. That source file also resolved a `sprint-N/` directory layout,
 * `current.json`, and — the bulk of it — which of several git worktrees is the "primary"
 * checkout a sprint's state should live in. None of that is a cards problem: a card store
 * is domain-scoped (see `domain.ts`), not worktree-scoped, so there is exactly one
 * candidate root to resolve against and no convergence logic is needed. What a card store
 * does need, and what this module provides, is (1) where its directory lives and (2)
 * reading/writing `*.md` cards in it without disturbing bytes nobody asked to touch — see
 * `card.ts` for the frontmatter mechanics this builds on.
 *
 * ## Where a card store lives
 *
 * `cards.dir` is configured per project (docs/cards.md) and, when set, resolves relative
 * to the domain root. There is deliberately **no default that implies committing**: cards
 * are the product of unsupervised agentic work, several kinds require verbatim quoting of
 * source material, and that combination is a leak generator. A project that wants cards
 * committed says so, explicitly (the recommended value for a Claude-Code-driven project is
 * `.claude/work-items`).
 *
 * So an unset `cards.dir` always falls back to `~/.mcp-cli/cards/<domain>/` —
 * unconditionally, not "when the domain root happens to be outside a git repo". A
 * conditional fallback ("in-repo when the root looks like a repo, home dir otherwise") is
 * exactly the kind of default the design rules out: it would still land unsupervised writes
 * inside a tracked directory whenever a domain root happened to be a git checkout, which is
 * the common case, not the exception. The unconditional fallback is the only shape with no
 * code path into a tracked directory.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type Card, type Scalar, parseCard, renderScalar, setFrontmatter } from "./card";
import { options } from "./constants";

/** Inputs to {@link resolveCardsDir}. */
export interface CardsDirInput {
  /** `cards.dir` from project config, exactly as written. `undefined`/`""` mean unset. */
  configuredDir: string | undefined;
  /** Domain name — the leaf of the home-dir fallback path, and the store's identity when unconfigured. */
  domain: string;
  /** Domain root. A configured `cards.dir` resolves relative to this; an unconfigured one ignores it. */
  root: string;
}

/**
 * Resolve the directory a domain's cards live in.
 *
 * `configuredDir` is honored verbatim (resolved against `root` when relative) — an explicit
 * config value is how a project opts into committing cards, and this function does not
 * second-guess that choice by re-deriving whether `root` is a git repo. Left unset, the
 * store falls back to `~/.mcp-cli/cards/<domain>/` unconditionally.
 */
export function resolveCardsDir(input: CardsDirInput): string {
  const { configuredDir, domain, root } = input;
  if (configuredDir !== undefined && configuredDir !== "") {
    return isAbsolute(configuredDir) ? configuredDir : resolve(root, configuredDir);
  }
  return join(options.MCP_CLI_DIR, "cards", domain);
}

/** Create a cards directory if it doesn't exist yet. Idempotent. */
export function ensureCardsDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

// ============================================================================
// Reading
// ============================================================================

/** Read and parse one card from disk. `path` is a full filesystem path. */
export function readCard(path: string): Card {
  return parseCard(path, readFileSync(path, "utf8"));
}

/** Every `*.md` card in `dir`, in filename order. `[]` when the directory doesn't exist yet. */
export function listCards(dir: string): Card[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => readCard(join(dir, name)));
}

// ============================================================================
// Writing
// ============================================================================

/** Write a new card. Refuses to clobber an existing file at `path`. */
export function createCard(path: string, contents: string): { ok: true } | { ok: false; error: string } {
  if (existsSync(path)) return { ok: false, error: `already exists: ${path}` };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents.endsWith("\n") ? contents : `${contents}\n`);
  return { ok: true };
}

/**
 * Set one frontmatter field on a card, in place — the surgical write docs/cards.md
 * requires. Reads the file, edits the one line {@link setFrontmatter} locates (or appends
 * it), and writes the whole file back. Every other byte — comments, blank lines, key order,
 * trailing whitespace — survives untouched.
 *
 * Takes a rendered string rather than a bare {@link Scalar} for list-valued fields (call
 * {@link renderList} first); {@link setCardScalarField} covers the common scalar case.
 */
export function setCardField(path: string, key: string, rendered: string): void {
  const text = readFileSync(path, "utf8");
  writeFileSync(path, setFrontmatter(text, key, rendered));
}

/** {@link setCardField}, rendering `value` with {@link renderScalar} first. */
export function setCardScalarField(path: string, key: string, value: Scalar): void {
  setCardField(path, key, renderScalar(value));
}
