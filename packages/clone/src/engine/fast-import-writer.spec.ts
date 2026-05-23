import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatMarksFile, generateFastImport, parseMarksFile } from "./fast-import-writer";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

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
    expect(decode(stream)).toContain("blob\nmark :1\ndata 6\nhello\n\n");
    expect(decode(stream)).toContain("commit refs/heads/main\n");
    expect(decode(stream)).toContain("mark :2\n");
    expect(decode(stream)).toContain("committer mcx <mcx@local> 0 +0000\n");
    expect(decode(stream)).toContain("data 4\ninit\n");
    expect(decode(stream)).toContain("M 100644 :1 README.md\n");
    expect(decode(stream).endsWith("done\n")).toBe(true);
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
    expect(decode(stream)).toContain("M 100644 :1 Engineering/Runbooks/Deployment.md\n");
    expect(decode(stream)).toContain("M 100644 :2 Product/Roadmap.md\n");
  });

  test("empty content emits `data 0`", () => {
    const { stream } = generateFastImport({
      entries: [{ path: "empty.md", content: "" }],
      ref: "refs/heads/main",
      message: "e",
    });
    expect(decode(stream)).toContain("blob\nmark :1\ndata 0\n\n");
  });

  test("byte length is computed in UTF-8 bytes, not codepoints", () => {
    // "é" is 2 bytes in UTF-8, 1 JS string unit.
    const content = "é";
    const { stream } = generateFastImport({
      entries: [{ path: "fr.md", content }],
      ref: "refs/heads/main",
      message: "m",
    });
    expect(decode(stream)).toContain("data 2\né\n");
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
    expect(decode(stream)).toContain("from :50\n");
    expect(decode(stream)).toContain("deleteall\n");
  });

  test("no parent means no `from` or `deleteall`", () => {
    const { stream } = generateFastImport({
      entries: [{ path: "x", content: "x" }],
      ref: "refs/heads/main",
      message: "m",
    });
    expect(decode(stream)).not.toContain("from ");
    expect(decode(stream)).not.toContain("deleteall");
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
    expect(decode(stream)).toContain("committer Alice <alice@example.com> 1700000000 +0000\n");
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
    expect(decode(stream)).toContain('M 100644 :1 "weird\\"name.md"\n');
    expect(decode(stream)).toContain('M 100644 :2 "with\\nnewline.md"\n');
    expect(decode(stream)).toContain('M 100644 :3 "with\\ttab.md"\n');
    expect(decode(stream)).toContain('M 100644 :4 "back\\\\slash.md"\n');
  });

  test("paths with spaces pass through unquoted (spec allows it)", () => {
    const { stream } = generateFastImport({
      entries: [{ path: "my file.md", content: "x" }],
      ref: "refs/heads/main",
      message: "m",
    });
    expect(decode(stream)).toContain("M 100644 :1 my file.md\n");
  });

  test("paths starting with double-quote are quoted", () => {
    const { stream } = generateFastImport({
      entries: [{ path: '"leading.md', content: "x" }],
      ref: "refs/heads/main",
      message: "m",
    });
    expect(decode(stream)).toContain('M 100644 :1 "\\"leading.md"\n');
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
    expect(decode(stream)).toContain("commit refs/heads/main\n");
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

  test("Uint8Array content uses raw byte length for data header", () => {
    const binary = new Uint8Array([0xc0, 0x80, 0xff, 0xfe, 0x00]);
    const { stream } = generateFastImport({
      entries: [{ path: "binary.bin", content: binary }],
      ref: "refs/heads/main",
      message: "m",
    });
    expect(decode(stream)).toContain("data 5\n");
  });

  test("Uint8Array content is embedded verbatim in stream", () => {
    const binary = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const { stream } = generateFastImport({
      entries: [{ path: "bin", content: binary }],
      ref: "refs/heads/main",
      message: "m",
    });
    const headerEnd = "data 4\n";
    const text = decode(stream);
    const headerIdx = text.indexOf(headerEnd);
    expect(headerIdx).toBeGreaterThan(0);
    const blobStart = stream.indexOf(0xde);
    expect(stream[blobStart]).toBe(0xde);
    expect(stream[blobStart + 1]).toBe(0xad);
    expect(stream[blobStart + 2]).toBe(0xbe);
    expect(stream[blobStart + 3]).toBe(0xef);
  });

  test("round-trip: binary Uint8Array content survives git fast-import", () => {
    const gitOk = spawnSync("git", ["--version"]).status === 0;
    if (!gitOk) return;

    const binary = new Uint8Array([0xc0, 0x80, 0xff, 0xfe, 0x00, 0x01, 0x7f, 0x80]);
    const dir = mkdtempSync(join(tmpdir(), "mcx-fast-import-bin-"));
    try {
      spawnSync("git", ["init", "--bare", "--initial-branch=main", dir], { stdio: "ignore", env: cleanGitEnv() });
      const { stream } = generateFastImport({
        entries: [{ path: "binary.bin", content: binary }],
        ref: "refs/heads/main",
        message: "import binary",
        timestamp: 1700000000,
      });
      const r = spawnSync("git", ["-C", dir, "fast-import"], { input: stream, env: cleanGitEnv() });
      expect(r.status).toBe(0);
      const show = spawnSync("git", ["-C", dir, "show", "refs/heads/main:binary.bin"], { env: cleanGitEnv() });
      expect(show.status).toBe(0);
      expect(new Uint8Array(show.stdout)).toEqual(binary);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mixed string and Uint8Array entries in same commit", () => {
    const gitOk = spawnSync("git", ["--version"]).status === 0;
    if (!gitOk) return;

    const binary = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const dir = mkdtempSync(join(tmpdir(), "mcx-fast-import-mix-"));
    try {
      spawnSync("git", ["init", "--bare", "--initial-branch=main", dir], { stdio: "ignore", env: cleanGitEnv() });
      const { stream } = generateFastImport({
        entries: [
          { path: "readme.md", content: "hello\n" },
          { path: "image.jpg", content: binary },
        ],
        ref: "refs/heads/main",
        message: "mixed",
        timestamp: 1700000000,
      });
      const r = spawnSync("git", ["-C", dir, "fast-import"], { input: stream, env: cleanGitEnv() });
      expect(r.status).toBe(0);
      const showText = spawnSync("git", ["-C", dir, "show", "refs/heads/main:readme.md"], { env: cleanGitEnv() });
      expect(showText.stdout.toString()).toBe("hello\n");
      const showBin = spawnSync("git", ["-C", dir, "show", "refs/heads/main:image.jpg"], { env: cleanGitEnv() });
      expect(new Uint8Array(showBin.stdout)).toEqual(binary);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("generateFastImport incremental mode", () => {
  test("incremental + parent emits `from` without `deleteall`", () => {
    const { stream } = generateFastImport({
      entries: [{ path: "x", content: "x" }],
      ref: "refs/heads/main",
      message: "m",
      parent: ":50",
      incremental: true,
    });
    const text = decode(stream);
    expect(text).toContain("from :50\n");
    expect(text).not.toContain("deleteall");
    expect(text).toContain("M 100644 :1 x\n");
  });

  test("deletions emit D lines with correct paths", () => {
    const { stream } = generateFastImport({
      entries: [{ path: "new.md", content: "hi" }],
      ref: "refs/heads/main",
      message: "m",
      parent: ":10",
      incremental: true,
      deletions: ["old.md", "docs/removed.md"],
    });
    const text = decode(stream);
    expect(text).toContain("D old.md\n");
    expect(text).toContain("D docs/removed.md\n");
    expect(text).not.toContain("deleteall");
  });

  test("deletions with special characters are C-quoted", () => {
    const { stream } = generateFastImport({
      entries: [],
      ref: "refs/heads/main",
      message: "m",
      parent: ":10",
      incremental: true,
      deletions: ['weird"name.md', "with\nnewline.md"],
    });
    const text = decode(stream);
    expect(text).toContain('D "weird\\"name.md"\n');
    expect(text).toContain('D "with\\nnewline.md"\n');
  });

  test("incremental with empty entries + parent is allowed (delete-only commit)", () => {
    const { stream } = generateFastImport({
      entries: [],
      ref: "refs/heads/main",
      message: "remove old files",
      parent: ":5",
      incremental: true,
      deletions: ["gone.md"],
    });
    const text = decode(stream);
    expect(text).toContain("from :5\n");
    expect(text).toContain("D gone.md\n");
    expect(text).not.toContain("deleteall");
  });

  test("deletions without parent throws", () => {
    expect(() =>
      generateFastImport({
        entries: [{ path: "x", content: "x" }],
        ref: "refs/heads/main",
        message: "m",
        deletions: ["old.md"],
      }),
    ).toThrow(/deletions require a parent/);
  });

  test("D lines appear before M lines in the stream", () => {
    const { stream } = generateFastImport({
      entries: [{ path: "new.md", content: "hi" }],
      ref: "refs/heads/main",
      message: "m",
      parent: ":1",
      incremental: true,
      startMark: 10,
      deletions: ["old.md"],
    });
    const text = decode(stream);
    const dIdx = text.indexOf("D old.md");
    const mIdx = text.indexOf("M 100644 :10 new.md");
    expect(dIdx).toBeGreaterThan(0);
    expect(mIdx).toBeGreaterThan(dIdx);
  });

  test("round-trip: incremental add preserves existing files", () => {
    const gitOk = spawnSync("git", ["--version"]).status === 0;
    if (!gitOk) return;

    const dir = mkdtempSync(join(tmpdir(), "mcx-fast-import-inc-"));
    const marksOut = join(dir, "marks");
    try {
      spawnSync("git", ["init", "--bare", "--initial-branch=main", dir], { stdio: "ignore", env: cleanGitEnv() });

      const first = generateFastImport({
        entries: [
          { path: "a.md", content: "alpha\n" },
          { path: "b.md", content: "beta\n" },
        ],
        ref: "refs/heads/main",
        message: "initial",
        timestamp: 1700000000,
      });
      const r1 = spawnSync("git", ["-C", dir, "fast-import", `--export-marks=${marksOut}`], {
        input: first.stream,
        env: cleanGitEnv(),
      });
      expect(r1.status).toBe(0);

      const second = generateFastImport({
        entries: [{ path: "c.md", content: "gamma\n" }],
        ref: "refs/heads/main",
        message: "add c only",
        parent: `:${first.commitMark}`,
        startMark: first.commitMark + 1,
        timestamp: 1700000001,
        incremental: true,
      });
      const r2 = spawnSync("git", ["-C", dir, "fast-import", `--import-marks=${marksOut}`], {
        input: second.stream,
        env: cleanGitEnv(),
      });
      expect(r2.status).toBe(0);

      const showA = spawnSync("git", ["-C", dir, "show", "refs/heads/main:a.md"], { env: cleanGitEnv() });
      expect(showA.status).toBe(0);
      expect(showA.stdout.toString()).toBe("alpha\n");

      const showB = spawnSync("git", ["-C", dir, "show", "refs/heads/main:b.md"], { env: cleanGitEnv() });
      expect(showB.status).toBe(0);
      expect(showB.stdout.toString()).toBe("beta\n");

      const showC = spawnSync("git", ["-C", dir, "show", "refs/heads/main:c.md"], { env: cleanGitEnv() });
      expect(showC.status).toBe(0);
      expect(showC.stdout.toString()).toBe("gamma\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("round-trip: incremental delete removes specific file, preserves others", () => {
    const gitOk = spawnSync("git", ["--version"]).status === 0;
    if (!gitOk) return;

    const dir = mkdtempSync(join(tmpdir(), "mcx-fast-import-del-"));
    const marksOut = join(dir, "marks");
    try {
      spawnSync("git", ["init", "--bare", "--initial-branch=main", dir], { stdio: "ignore", env: cleanGitEnv() });

      const first = generateFastImport({
        entries: [
          { path: "keep.md", content: "keep\n" },
          { path: "remove.md", content: "bye\n" },
        ],
        ref: "refs/heads/main",
        message: "initial",
        timestamp: 1700000000,
      });
      const r1 = spawnSync("git", ["-C", dir, "fast-import", `--export-marks=${marksOut}`], {
        input: first.stream,
        env: cleanGitEnv(),
      });
      expect(r1.status).toBe(0);

      const second = generateFastImport({
        entries: [],
        ref: "refs/heads/main",
        message: "delete remove.md",
        parent: `:${first.commitMark}`,
        startMark: first.commitMark + 1,
        timestamp: 1700000001,
        incremental: true,
        deletions: ["remove.md"],
      });
      const r2 = spawnSync("git", ["-C", dir, "fast-import", `--import-marks=${marksOut}`], {
        input: second.stream,
        env: cleanGitEnv(),
      });
      expect(r2.status).toBe(0);

      const showKeep = spawnSync("git", ["-C", dir, "show", "refs/heads/main:keep.md"], { env: cleanGitEnv() });
      expect(showKeep.status).toBe(0);
      expect(showKeep.stdout.toString()).toBe("keep\n");

      const showRemoved = spawnSync("git", ["-C", dir, "show", "refs/heads/main:remove.md"], { env: cleanGitEnv() });
      expect(showRemoved.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("round-trip: incremental update modifies one file, preserves another", () => {
    const gitOk = spawnSync("git", ["--version"]).status === 0;
    if (!gitOk) return;

    const dir = mkdtempSync(join(tmpdir(), "mcx-fast-import-upd-"));
    const marksOut = join(dir, "marks");
    try {
      spawnSync("git", ["init", "--bare", "--initial-branch=main", dir], { stdio: "ignore", env: cleanGitEnv() });

      const first = generateFastImport({
        entries: [
          { path: "a.md", content: "v1\n" },
          { path: "b.md", content: "unchanged\n" },
        ],
        ref: "refs/heads/main",
        message: "initial",
        timestamp: 1700000000,
      });
      const r1 = spawnSync("git", ["-C", dir, "fast-import", `--export-marks=${marksOut}`], {
        input: first.stream,
        env: cleanGitEnv(),
      });
      expect(r1.status).toBe(0);

      const second = generateFastImport({
        entries: [{ path: "a.md", content: "v2\n" }],
        ref: "refs/heads/main",
        message: "update a only",
        parent: `:${first.commitMark}`,
        startMark: first.commitMark + 1,
        timestamp: 1700000001,
        incremental: true,
      });
      const r2 = spawnSync("git", ["-C", dir, "fast-import", `--import-marks=${marksOut}`], {
        input: second.stream,
        env: cleanGitEnv(),
      });
      expect(r2.status).toBe(0);

      const showA = spawnSync("git", ["-C", dir, "show", "refs/heads/main:a.md"], { env: cleanGitEnv() });
      expect(showA.stdout.toString()).toBe("v2\n");

      const showB = spawnSync("git", ["-C", dir, "show", "refs/heads/main:b.md"], { env: cleanGitEnv() });
      expect(showB.stdout.toString()).toBe("unchanged\n");
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

  test("parseMarksFile reads SHA-256 (64-char) hashes", () => {
    const sha256 = "a".repeat(64);
    const text = `:1 ${sha256}\n`;
    const m = parseMarksFile(text);
    expect(m.get(1)).toBe(sha256);
  });

  test("parseMarksFile handles mixed SHA-1 and SHA-256 marks", () => {
    const sha1 = "b".repeat(40);
    const sha256 = "c".repeat(64);
    const text = `:1 ${sha1}\n:2 ${sha256}\n`;
    const m = parseMarksFile(text);
    expect(m.size).toBe(2);
    expect(m.get(1)).toBe(sha1);
    expect(m.get(2)).toBe(sha256);
  });

  test("parseMarksFile ignores malformed lines", () => {
    const m = parseMarksFile("garbage\n:7 short\n:9 cccccccccccccccccccccccccccccccccccccccc\n");
    expect(m.size).toBe(1);
    expect(m.get(9)).toBe("cccccccccccccccccccccccccccccccccccccccc");
  });

  test("parseMarksFile rejects hashes between 41 and 63 chars", () => {
    const bad50 = "d".repeat(50);
    const m = parseMarksFile(`:1 ${bad50}\n`);
    expect(m.size).toBe(0);
  });

  test("parseMarksFile rejects hashes longer than 64 chars", () => {
    const bad70 = "e".repeat(70);
    const m = parseMarksFile(`:1 ${bad70}\n`);
    expect(m.size).toBe(0);
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
