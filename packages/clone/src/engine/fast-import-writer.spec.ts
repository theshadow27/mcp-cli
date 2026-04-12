import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatMarksFile, generateFastImport, parseMarksFile } from "./fast-import-writer";

/**
 * Filter out git-inherited env vars (GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE)
 * that would redirect child `git fast-import` processes to the parent repo
 * instead of the throwaway test directory — see #1282.
 */
function cleanGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "GIT_DIR" || k === "GIT_INDEX_FILE" || k === "GIT_WORK_TREE") continue;
    if (v !== undefined) env[k] = v;
  }
  return env;
}

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

  test("paths with special characters are C-quoted", () => {
    const { stream } = generateFastImport({
      entries: [
        { path: 'weird"name.md', content: "x" },
        { path: "with\nnewline.md", content: "y" },
        { path: "with\ttab.md", content: "z" },
        { path: "back\\slash.md", content: "w" },
      ],
      ref: "refs/heads/main",
      message: "m",
    });
    expect(stream).toContain('M 100644 :1 "weird\\"name.md"\n');
    expect(stream).toContain('M 100644 :2 "with\\nnewline.md"\n');
    expect(stream).toContain('M 100644 :3 "with\\ttab.md"\n');
    expect(stream).toContain('M 100644 :4 "back\\\\slash.md"\n');
  });

  test("paths with spaces pass through unquoted (spec allows it)", () => {
    const { stream } = generateFastImport({
      entries: [{ path: "my file.md", content: "x" }],
      ref: "refs/heads/main",
      message: "m",
    });
    expect(stream).toContain("M 100644 :1 my file.md\n");
  });

  test("paths starting with double-quote are quoted", () => {
    const { stream } = generateFastImport({
      entries: [{ path: '"leading.md', content: "x" }],
      ref: "refs/heads/main",
      message: "m",
    });
    expect(stream).toContain('M 100644 :1 "\\"leading.md"\n');
  });

  test("empty entries + parent throws (would wipe branch)", () => {
    expect(() =>
      generateFastImport({
        entries: [],
        ref: "refs/heads/main",
        message: "m",
        parent: ":5",
      }),
    ).toThrow(/branch-wiping/);
  });

  test("empty entries without parent is allowed (initial empty commit is fine to skip guard)", () => {
    // No parent means this is just an orphan commit on a ref with no blobs —
    // not the branch-wiping case. Should not throw.
    const { stream } = generateFastImport({
      entries: [],
      ref: "refs/heads/main",
      message: "m",
    });
    expect(stream).toContain("commit refs/heads/main\n");
  });

  test("commitMark colliding with blob range throws", () => {
    expect(() =>
      generateFastImport({
        entries: [
          { path: "a", content: "A" },
          { path: "b", content: "B" },
        ],
        ref: "refs/heads/main",
        message: "m",
        startMark: 1,
        commitMark: 1,
      }),
    ).toThrow(/collides/);
  });

  test("commitMark outside blob range is accepted", () => {
    const { commitMark } = generateFastImport({
      entries: [{ path: "a", content: "A" }],
      ref: "refs/heads/main",
      message: "m",
      startMark: 1,
      commitMark: 99,
    });
    expect(commitMark).toBe(99);
  });

  test("round-trip: path with space survives git fast-import", () => {
    const gitOk = spawnSync("git", ["--version"]).status === 0;
    if (!gitOk) return;

    const dir = mkdtempSync(join(tmpdir(), "mcx-fast-import-sp-"));
    try {
      spawnSync("git", ["init", "--bare", "--initial-branch=main", dir], { stdio: "ignore", env: cleanGitEnv() });
      const { stream } = generateFastImport({
        entries: [{ path: "my file.md", content: "hi\n" }],
        ref: "refs/heads/main",
        message: "m",
        timestamp: 1700000000,
      });
      const r = spawnSync("git", ["-C", dir, "fast-import"], { input: stream, env: cleanGitEnv() });
      expect(r.status).toBe(0);
      const show = spawnSync("git", ["-C", dir, "show", "refs/heads/main:my file.md"], { env: cleanGitEnv() });
      expect(show.status).toBe(0);
      expect(show.stdout.toString()).toBe("hi\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("round-trip: quoted path with double-quote survives git fast-import", () => {
    const gitOk = spawnSync("git", ["--version"]).status === 0;
    if (!gitOk) return;

    const dir = mkdtempSync(join(tmpdir(), "mcx-fast-import-q-"));
    try {
      spawnSync("git", ["init", "--bare", "--initial-branch=main", dir], { stdio: "ignore", env: cleanGitEnv() });
      const { stream } = generateFastImport({
        entries: [{ path: 'weird"name.md', content: "ok\n" }],
        ref: "refs/heads/main",
        message: "m",
        timestamp: 1700000000,
      });
      const r = spawnSync("git", ["-C", dir, "fast-import"], { input: stream, env: cleanGitEnv() });
      expect(r.status).toBe(0);
      const show = spawnSync("git", ["-C", dir, "show", 'refs/heads/main:weird"name.md'], { env: cleanGitEnv() });
      expect(show.status).toBe(0);
      expect(show.stdout.toString()).toBe("ok\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("round-trip: git fast-import reproduces the commit and content", () => {
    const gitOk = spawnSync("git", ["--version"]).status === 0;
    if (!gitOk) return;

    const dir = mkdtempSync(join(tmpdir(), "mcx-fast-import-"));
    try {
      spawnSync("git", ["init", "--bare", "--initial-branch=main", dir], { stdio: "ignore", env: cleanGitEnv() });

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

      const importRes = spawnSync("git", ["-C", dir, "fast-import"], { input: stream, env: cleanGitEnv() });
      expect(importRes.status).toBe(0);

      const log = spawnSync("git", ["-C", dir, "log", "--format=%s", "refs/heads/main"], { env: cleanGitEnv() });
      expect(log.status).toBe(0);
      expect(log.stdout.toString().trim()).toBe("import");

      const show = spawnSync("git", ["-C", dir, "show", "refs/heads/main:docs/guide.md"], { env: cleanGitEnv() });
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
      spawnSync("git", ["init", "--bare", "--initial-branch=main", dir], { stdio: "ignore", env: cleanGitEnv() });

      const first = generateFastImport({
        entries: [{ path: "a.md", content: "one\n" }],
        ref: "refs/heads/main",
        message: "first",
        timestamp: 1700000000,
      });
      const r1 = spawnSync("git", ["-C", dir, "fast-import", `--export-marks=${marksOut}`], {
        input: first.stream,
        env: cleanGitEnv(),
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
        env: cleanGitEnv(),
      });
      expect(r2.status).toBe(0);

      const log = spawnSync("git", ["-C", dir, "log", "--format=%s", "refs/heads/main"], { env: cleanGitEnv() });
      expect(log.stdout.toString().trim().split("\n")).toEqual(["second", "first"]);

      const show = spawnSync("git", ["-C", dir, "show", "refs/heads/main:a.md"], { env: cleanGitEnv() });
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
