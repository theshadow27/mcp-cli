import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { testOptions } from "../../../test/test-options";
import {
  createCard,
  ensureCardsDir,
  listCards,
  readCard,
  resolveCardsDir,
  setCardField,
  setCardScalarField,
} from "./card-store";
import { gitDiscoverEnv } from "./git";

describe("resolveCardsDir", () => {
  test("honors an explicit relative cards.dir, resolved against the domain root", () => {
    using opts = testOptions();
    const dir = resolveCardsDir({ configuredDir: ".claude/work-items", domain: "phoenix", root: opts.dir });
    expect(dir).toBe(join(opts.dir, ".claude/work-items"));
  });

  test("honors an explicit absolute cards.dir verbatim", () => {
    using opts = testOptions();
    const absolute = join(opts.dir, "elsewhere");
    const dir = resolveCardsDir({ configuredDir: absolute, domain: "phoenix", root: opts.dir });
    expect(dir).toBe(absolute);
  });

  test("acceptance: unconfigured outside a git repo lands in ~/.mcp-cli/cards/<domain>/", () => {
    using opts = testOptions();
    const plainDir = mkdtempSync(join(tmpdir(), "cards-nongit-"));
    try {
      expect(existsSync(join(plainDir, ".git"))).toBe(false);
      const dir = resolveCardsDir({ configuredDir: undefined, domain: "phoenix", root: plainDir });
      expect(dir).toBe(join(opts.dir, "cards", "phoenix"));
      expect(isAbsolute(dir)).toBe(true);
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });

  test("acceptance: unconfigured stays out of a tracked directory even when root IS a git repo", () => {
    using opts = testOptions();
    const repoDir = mkdtempSync(join(tmpdir(), "cards-git-"));
    try {
      // Strip inherited GIT_DIR/GIT_WORK_TREE/etc — this spec can itself run inside a git
      // hook (am-i-done's own pre-commit/pre-push), and without stripping them `git init`
      // silently follows the *hook's* GIT_DIR instead of initializing repoDir (#3066 review).
      const init = Bun.spawnSync(["git", "init", "-q", repoDir], { env: gitDiscoverEnv() });
      expect(init.success).toBe(true);
      expect(existsSync(join(repoDir, ".git"))).toBe(true);

      const dir = resolveCardsDir({ configuredDir: undefined, domain: "phoenix", root: repoDir });

      // The unconfigured fallback never lands inside — or anywhere near — the repo root,
      // tracked or not. This is the whole acceptance bar: no code path from "unconfigured"
      // to "inside a directory git could pick up".
      expect(dir.startsWith(repoDir)).toBe(false);
      expect(dir).toBe(join(opts.dir, "cards", "phoenix"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("empty string is treated the same as unset", () => {
    using opts = testOptions();
    const dir = resolveCardsDir({ configuredDir: "", domain: "phoenix", root: opts.dir });
    expect(dir).toBe(join(opts.dir, "cards", "phoenix"));
  });

  test("the home-dir fallback is scoped per domain", () => {
    using opts = testOptions();
    const a = resolveCardsDir({ configuredDir: undefined, domain: "phoenix", root: opts.dir });
    const b = resolveCardsDir({ configuredDir: undefined, domain: "octovalve", root: opts.dir });
    expect(a).not.toBe(b);
    expect(a).toBe(join(opts.dir, "cards", "phoenix"));
    expect(b).toBe(join(opts.dir, "cards", "octovalve"));
  });
});

describe("createCard / readCard / listCards", () => {
  test("createCard writes a new file, adding a trailing newline if missing", () => {
    using opts = testOptions();
    const dir = join(opts.dir, "items");
    const path = join(dir, "01-foo.md");
    const result = createCard(path, "---\nstatus: queued\n---\n\n# Foo");
    expect(result).toEqual({ ok: true });
    expect(readFileSync(path, "utf8")).toBe("---\nstatus: queued\n---\n\n# Foo\n");
  });

  test("createCard refuses to clobber an existing card", () => {
    using opts = testOptions();
    const path = join(opts.dir, "items", "01-foo.md");
    createCard(path, "first");
    const result = createCard(path, "second");
    expect(result.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("first\n");
  });

  test("readCard parses a card from disk", () => {
    using opts = testOptions();
    const path = join(opts.dir, "01-foo.md");
    createCard(path, "---\nstatus: active\n---\n\n# Foo\n");
    const card = readCard(path);
    expect(card.front).toEqual({ status: "active" });
    expect(card.parseError).toBeUndefined();
  });

  test("listCards returns [] for a directory that does not exist yet", () => {
    using opts = testOptions();
    expect(listCards(join(opts.dir, "nope"))).toEqual([]);
  });

  test("listCards reads every *.md file, sorted, ignoring non-markdown files", () => {
    using opts = testOptions();
    const dir = join(opts.dir, "items");
    ensureCardsDir(dir);
    createCard(join(dir, "02-second.md"), "---\nstatus: queued\n---\n\n# Second\n");
    createCard(join(dir, "01-first.md"), "---\nstatus: done\n---\n\n# First\n");
    Bun.write(join(dir, "README.txt"), "not a card");

    const cards = listCards(dir);
    expect(cards.map((c) => c.front.status)).toEqual(["done", "queued"]);
  });
});

describe("setCardField / setCardScalarField — surgical write", () => {
  test("setCardScalarField edits only the target field on disk", () => {
    using opts = testOptions();
    const path = join(opts.dir, "01-foo.md");
    const original = [
      "---",
      "status: queued",
      "# a hand-written comment",
      "priority: 2",
      "owner: loop",
      "---",
      "",
      "# Foo",
      "",
      "Body prose.",
      "",
    ].join("\n");
    createCard(path, original);

    setCardScalarField(path, "status", "active");

    const updated = readFileSync(path, "utf8");
    expect(updated).toBe(original.replace("status: queued", "status: active"));
  });

  test("setCardField writes a pre-rendered value verbatim (list-field case)", () => {
    using opts = testOptions();
    const path = join(opts.dir, "01-foo.md");
    createCard(path, "---\nissues: []\n---\n\n# Foo\n");

    setCardField(path, "issues", "[916, 917]");

    expect(readFileSync(path, "utf8")).toBe("---\nissues: [916, 917]\n---\n\n# Foo\n");
  });

  test("setCardScalarField appends the key when the card had none of it", () => {
    using opts = testOptions();
    const path = join(opts.dir, "01-foo.md");
    createCard(path, "---\nstatus: queued\n---\n\n# Foo\n");

    setCardScalarField(path, "owner", "human");

    expect(readFileSync(path, "utf8")).toBe("---\nstatus: queued\nowner: human\n---\n\n# Foo\n");
  });
});

describe("ensureCardsDir", () => {
  test("is idempotent", () => {
    using opts = testOptions();
    const dir = join(opts.dir, "cards", "phoenix");
    ensureCardsDir(dir);
    ensureCardsDir(dir);
    expect(existsSync(dir)).toBe(true);
  });
});
