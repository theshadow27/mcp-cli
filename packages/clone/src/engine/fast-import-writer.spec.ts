import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatMarksFile, generateFastImport, parseMarksFile } from "./fast-import-writer";

describe("generateFastImport", () => {
  test("single file produces a well-formed blob + commit", () => {
    const { stream, marks, commitMark } = generateFastImport({
      entries: [{ path: "README.md", content: "hello\n" }],
      ref: "refs/heads/main",
      message: "init",
    });

    expect(marks).toEqual({ "README.md": 1 });
    expect(commitMark).toBe(2);
    expect(stream).toContain("blob\nmark :1\ndata 6\nhello\n\n");
    expect(stream).toContain("commit refs/heads/main\n");
    expect(stream).toContain("mark :2\n");
    expect(stream).toContain("committer mcx <mcx@local> 0 +0000\n");
    expect(stream).toContain("data 4\ninit\n");
    expect(stream).toContain("M 100644 :1 README.md\n");
    expect(stream.endsWith("done\n")).toBe(true);
  });

  test("nested directory paths are preserved verbatim", () => {
    const { stream, marks } = generateFastImport({
      entries: [
        { path: "Engineering/Runbooks/Deployment.md", content: "a" },
        { path: "Product/Roadmap.md", content: "b" },
      ],
      ref: "refs/heads/main",
      message: "seed",
    });

    expect(marks["Engineering/Runbooks/Deployment.md"]).toBe(1);
    expect(marks["Product/Roadmap.md"]).toBe(2);
    expect(stream).toContain("M 100644 :1 Engineering/Runbooks/Deployment.md\n");
    expect(stream).toContain("M 100644 :2 Product/Roadmap.md\n");
  });

  test("empty content emits `data 0`", () => {
    const { stream } = generateFastImport({
      entries: [{ path: "empty.md", content: "" }],
      ref: "refs/heads/main",
      message: "e",
    });
    expect(stream).toContain("blob\nmark :1\ndata 0\n\n");
  });

  test("byte length is computed in UTF-8 bytes, not codepoints", () => {
    // "é" is 2 bytes in UTF-8, 1 JS string unit.
    const content = "é";
    const { stream } = generateFastImport({
      entries: [{ path: "fr.md", content }],
      ref: "refs/heads/main",
      message: "m",
    });
    expect(stream).toContain("data 2\né\n");
  });

  test("startMark shifts numbering for incremental imports", () => {
    const { marks, commitMark } = generateFastImport({
      entries: [
        { path: "a", content: "A" },
        { path: "b", content: "B" },
      ],
      ref: "refs/heads/main",
      message: "m",
      startMark: 100,
    });
    expect(marks).toEqual({ a: 100, b: 101 });
    expect(commitMark).toBe(102);
  });

  test("parent triggers a `from` line and `deleteall` for full-tree semantics", () => {
    const { stream } = generateFastImport({
      entries: [{ path: "x", content: "x" }],
      ref: "refs/heads/main",
      message: "m",
      parent: ":50",
    });
    expect(stream).toContain("from :50\n");
    expect(stream).toContain("deleteall\n");
  });

  test("no parent means no `from` or `deleteall`", () => {
    const { stream } = generateFastImport({
      entries: [{ path: "x", content: "x" }],
      ref: "refs/heads/main",
      message: "m",
    });
    expect(stream).not.toContain("from ");
    expect(stream).not.toContain("deleteall");
  });

  test("custom committer identity and timestamp", () => {
    const { stream } = generateFastImport({
      entries: [{ path: "x", content: "x" }],
      ref: "refs/heads/main",
      message: "m",
      committerName: "Alice",
      committerEmail: "alice@example.com",
      timestamp: 1700000000,
    });
    expect(stream).toContain("committer Alice <alice@example.com> 1700000000 +0000\n");
  });

  test("round-trip: git fast-import reproduces the commit and content", () => {
    const gitOk = spawnSync("git", ["--version"]).status === 0;
    if (!gitOk) return;

    const dir = mkdtempSync(join(tmpdir(), "mcx-fast-import-"));
    try {
      spawnSync("git", ["init", "--bare", "--initial-branch=main", dir], { stdio: "ignore" });

      const { stream } = generateFastImport({
        entries: [
          { path: "README.md", content: "# hello\n" },
          { path: "docs/guide.md", content: "body with é and 🙂\n" },
        ],
        ref: "refs/heads/main",
        message: "import\n",
        timestamp: 1700000000,
      });

      const streamPath = join(dir, "stream");
      writeFileSync(streamPath, stream);

      const importRes = spawnSync("git", ["-C", dir, "fast-import"], { input: stream });
      expect(importRes.status).toBe(0);

      const log = spawnSync("git", ["-C", dir, "log", "--format=%s", "refs/heads/main"]);
      expect(log.status).toBe(0);
      expect(log.stdout.toString().trim()).toBe("import");

      const show = spawnSync("git", ["-C", dir, "show", "refs/heads/main:docs/guide.md"]);
      expect(show.status).toBe(0);
      expect(show.stdout.toString()).toBe("body with é and 🙂\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("round-trip with parent: two commits build on each other", () => {
    const gitOk = spawnSync("git", ["--version"]).status === 0;
    if (!gitOk) return;

    const dir = mkdtempSync(join(tmpdir(), "mcx-fast-import-p-"));
    const marksOut = join(dir, "marks");
    try {
      spawnSync("git", ["init", "--bare", "--initial-branch=main", dir], { stdio: "ignore" });

      const first = generateFastImport({
        entries: [{ path: "a.md", content: "one\n" }],
        ref: "refs/heads/main",
        message: "first",
        timestamp: 1700000000,
      });
      const r1 = spawnSync("git", ["-C", dir, "fast-import", `--export-marks=${marksOut}`], {
        input: first.stream,
      });
      expect(r1.status).toBe(0);

      const loaded = parseMarksFile(readFileSync(marksOut, "utf8"));
      expect(loaded.size).toBe(2);

      const second = generateFastImport({
        entries: [{ path: "a.md", content: "two\n" }],
        ref: "refs/heads/main",
        message: "second",
        parent: `:${first.commitMark}`,
        startMark: first.commitMark + 1,
        timestamp: 1700000001,
      });
      const r2 = spawnSync("git", ["-C", dir, "fast-import", `--import-marks=${marksOut}`], {
        input: second.stream,
      });
      expect(r2.status).toBe(0);

      const log = spawnSync("git", ["-C", dir, "log", "--format=%s", "refs/heads/main"]);
      expect(log.stdout.toString().trim().split("\n")).toEqual(["second", "first"]);

      const show = spawnSync("git", ["-C", dir, "show", "refs/heads/main:a.md"]);
      expect(show.stdout.toString()).toBe("two\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("marks file parsing", () => {
  test("parseMarksFile reads `:mark sha` lines", () => {
    const text = ":1 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n:42 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n";
    const m = parseMarksFile(text);
    expect(m.get(1)).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(m.get(42)).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  test("parseMarksFile ignores malformed lines", () => {
    const m = parseMarksFile("garbage\n:7 short\n:9 cccccccccccccccccccccccccccccccccccccccc\n");
    expect(m.size).toBe(1);
    expect(m.get(9)).toBe("cccccccccccccccccccccccccccccccccccccccc");
  });

  test("formatMarksFile round-trips through parseMarksFile in mark order", () => {
    const original = new Map<number, string>([
      [10, "1111111111111111111111111111111111111111"],
      [2, "2222222222222222222222222222222222222222"],
    ]);
    const text = formatMarksFile(original);
    expect(text.split("\n")[0]).toBe(":2 2222222222222222222222222222222222222222");
    const parsed = parseMarksFile(text);
    expect(parsed.get(2)).toBe("2222222222222222222222222222222222222222");
    expect(parsed.get(10)).toBe("1111111111111111111111111111111111111111");
  });
});
