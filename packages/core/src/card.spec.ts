import { describe, expect, test } from "bun:test";
import {
  idFromPath,
  parseCard,
  readEnum,
  readList,
  readNumber,
  readString,
  renderList,
  renderScalar,
  setFrontmatter,
  splitFrontmatter,
  titleOf,
} from "./card";

describe("splitFrontmatter", () => {
  test("splits a well-formed document", () => {
    const { frontText, body } = splitFrontmatter("---\nstatus: open\n---\n\n# Title\n");
    expect(frontText).toBe("status: open");
    expect(body).toBe("\n# Title\n");
  });

  test("returns null frontText for a document with no leading fence", () => {
    const { frontText, body } = splitFrontmatter("# Just a heading\n\nsome text\n");
    expect(frontText).toBeNull();
    expect(body).toBe("# Just a heading\n\nsome text\n");
  });

  test("returns null frontText for an unclosed fence", () => {
    const { frontText, body } = splitFrontmatter("---\nstatus: open\n\n# no closing fence\n");
    expect(frontText).toBeNull();
    expect(body).toBe("---\nstatus: open\n\n# no closing fence\n");
  });

  test("strips a leading BOM before checking for the fence", () => {
    const { frontText } = splitFrontmatter("﻿---\nstatus: open\n---\nbody\n");
    expect(frontText).toBe("status: open");
  });
});

describe("parseCard", () => {
  test("parses valid frontmatter into a mapping", () => {
    const card = parseCard("a.md", "---\nstatus: open\norder: 3\n---\n\nbody\n");
    expect(card.front).toEqual({ status: "open", order: 3 });
    expect(card.parseError).toBeUndefined();
    expect(card.body).toBe("\nbody\n");
  });

  test("never throws on unparseable YAML — reports parseError instead", () => {
    const card = parseCard("a.md", "---\nstatus: [unterminated\n---\nbody\n");
    expect(card.front).toEqual({});
    expect(card.parseError).toBeDefined();
  });

  test("reports parseError when frontmatter is a scalar or list, not a mapping", () => {
    const card = parseCard("a.md", "---\n- one\n- two\n---\nbody\n");
    expect(card.front).toEqual({});
    expect(card.parseError).toBe("frontmatter is not a mapping");
  });

  test("a card with no frontmatter parses as all-body with empty front", () => {
    const card = parseCard("a.md", "just prose\n");
    expect(card.front).toEqual({});
    expect(card.frontText).toBe("");
    expect(card.body).toBe("just prose\n");
  });
});

describe("renderScalar", () => {
  test("numbers and booleans render bare", () => {
    expect(renderScalar(3)).toBe("3");
    expect(renderScalar(true)).toBe("true");
    expect(renderScalar(false)).toBe("false");
  });

  test("null renders as the YAML null literal", () => {
    expect(renderScalar(null)).toBe("null");
  });

  test("empty string is quoted so it round-trips as a string, not absence", () => {
    expect(renderScalar("")).toBe('""');
  });

  test("plain strings render bare", () => {
    expect(renderScalar("loop")).toBe("loop");
  });

  test("a value containing an inline comment marker is quoted (PR #1241 case)", () => {
    expect(renderScalar("PR #1241")).toBe(JSON.stringify("PR #1241"));
  });

  test("a value that opens like a number is quoted even though it is a string", () => {
    expect(renderScalar("24-1120")).toBe(JSON.stringify("24-1120"));
  });

  test("YAML boolean/null keywords are quoted so they stay strings", () => {
    expect(renderScalar("true")).toBe(JSON.stringify("true"));
    expect(renderScalar("yes")).toBe(JSON.stringify("yes"));
    expect(renderScalar("null")).toBe(JSON.stringify("null"));
  });

  test("a bare value round-trips through parseCard unchanged", () => {
    const rendered = renderScalar("loop");
    const card = parseCard("a.md", `---\nowner: ${rendered}\n---\n`);
    expect(card.front.owner).toBe("loop");
  });

  test("a quoted value round-trips through parseCard to the original string", () => {
    const original = "PR #1241";
    const rendered = renderScalar(original);
    const card = parseCard("a.md", `---\nactioned-as: ${rendered}\n---\n`);
    expect(card.front["actioned-as"]).toBe(original);
  });
});

describe("renderList", () => {
  test("renders an empty list", () => {
    expect(renderList([])).toBe("[]");
  });

  test("renders a list of scalars, quoting members that need it", () => {
    // Each entry goes through renderScalar, so a numeric-looking string id is quoted —
    // same rule as any other scalar (the PR-number / leading-digit case above).
    expect(renderList(["916", "917"])).toBe('["916", "917"]');
  });

  test("renders a list of plain-word scalars bare", () => {
    expect(renderList(["a", "b"])).toBe("[a, b]");
  });
});

describe("setFrontmatter — surgical single-line write", () => {
  test("acceptance: an unrelated hand-written card survives a set byte-for-byte except the target line", () => {
    const original = [
      "---",
      "status: queued",
      "# priority is explicit here, order is the tiebreak",
      "priority: 2",
      "",
      'title:   "Foley emails opt-in"   ',
      "issues: [916, 917]",
      "owner: loop",
      "---",
      "",
      "# Foley emails opt-in",
      "",
      "Some body prose with   odd   spacing.",
      "",
    ].join("\n");

    const updated = setFrontmatter(original, "status", "active");

    const expected = original.replace("status: queued", "status: active");
    expect(updated).toBe(expected);

    // Every other line, including the comment, the blank line inside the block, the
    // quoted+padded title, and the trailing-whitespace body line, is untouched.
    const originalLines = original.split("\n");
    const updatedLines = updated.split("\n");
    expect(updatedLines.length).toBe(originalLines.length);
    for (let i = 0; i < originalLines.length; i++) {
      if (originalLines[i]?.startsWith("status:")) continue;
      expect(updatedLines[i]).toBe(originalLines[i]);
    }
  });

  test("appends the key when absent, without touching existing lines", () => {
    const original = "---\nstatus: queued\n---\n\nbody\n";
    const updated = setFrontmatter(original, "owner", "loop");
    expect(updated).toBe("---\nstatus: queued\nowner: loop\n---\n\nbody\n");
  });

  test("gives a document with no frontmatter a fresh block, leaving the rest untouched", () => {
    const original = "# Just prose\n\nno frontmatter here\n";
    const updated = setFrontmatter(original, "status", "queued");
    expect(updated).toBe(`---\nstatus: queued\n---\n${original}`);
  });

  test("a key regex-special in name (e.g. containing a dot) is treated literally", () => {
    const original = "---\nactioned.as: none\n---\nbody\n";
    const updated = setFrontmatter(original, "actioned.as", "PR");
    expect(updated).toBe("---\nactioned.as: PR\n---\nbody\n");
  });

  test("only matches the exact key, not one it is a prefix of", () => {
    const original = "---\nstatus: queued\nstatus-note: fine\n---\nbody\n";
    const updated = setFrontmatter(original, "status", "active");
    expect(updated).toBe("---\nstatus: active\nstatus-note: fine\n---\nbody\n");
  });

  test("preserves the body's own leading blank line", () => {
    const original = "---\nstatus: queued\n---\n\n# Heading\n";
    const updated = setFrontmatter(original, "status", "active");
    expect(updated.slice(updated.indexOf("---\n\n") + "---\n".length)).toStartWith("\n# Heading\n");
  });
});

describe("readString / readNumber / readList / readEnum", () => {
  test("readString trims and rejects blank-only values", () => {
    expect(readString({ a: "  hi  " }, "a")).toBe("hi");
    expect(readString({ a: "   " }, "a")).toBeUndefined();
    expect(readString({}, "a")).toBeUndefined();
  });

  test("readString stringifies a numeric field", () => {
    expect(readString({ a: 42 }, "a")).toBe("42");
  });

  test("readNumber accepts a numeric string and rejects garbage", () => {
    expect(readNumber({ a: "3" }, "a")).toBe(3);
    expect(readNumber({ a: "not a number" }, "a")).toBeUndefined();
    expect(readNumber({ a: Number.NaN }, "a")).toBeUndefined();
  });

  test("readList accepts an array, a bare scalar, or a comma-separated string identically", () => {
    expect(readList({ a: ["1", "2"] }, "a")).toEqual(["1", "2"]);
    expect(readList({ a: 5 }, "a")).toEqual(["5"]);
    expect(readList({ a: "1, 2 ,3" }, "a")).toEqual(["1", "2", "3"]);
    expect(readList({}, "a")).toEqual([]);
    expect(readList({ a: null }, "a")).toEqual([]);
  });

  test("readList drops non-scalar array entries", () => {
    expect(readList({ a: ["1", { nested: true }, "2"] }, "a")).toEqual(["1", "2"]);
  });

  test("readEnum matches case-insensitively and rejects values outside the allowed set", () => {
    expect(readEnum({ a: "ACTIVE" }, "a", ["queued", "active"] as const)).toBe("active");
    expect(readEnum({ a: "bogus" }, "a", ["queued", "active"] as const)).toBeUndefined();
    expect(readEnum({}, "a", ["queued", "active"] as const)).toBeUndefined();
  });
});

describe("titleOf", () => {
  test("finds the first markdown heading", () => {
    const card = parseCard("a.md", "---\nstatus: open\n---\n\nSome prose.\n\n## The Title\n\nmore.\n");
    expect(titleOf(card, "fallback")).toBe("The Title");
  });

  test("falls back when there is no heading", () => {
    const card = parseCard("a.md", "---\nstatus: open\n---\n\nno heading here\n");
    expect(titleOf(card, "fallback-id")).toBe("fallback-id");
  });
});

describe("idFromPath", () => {
  test("strips the directory and .md extension", () => {
    expect(idFromPath("a/b/01-foley-emails-optin.md")).toBe("01-foley-emails-optin");
  });

  test("handles a bare filename", () => {
    expect(idFromPath("card.md")).toBe("card");
  });
});
