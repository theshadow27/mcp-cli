import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFastImport } from "./fast-import-parser";

const dec = new TextDecoder();
const asText = (b: Uint8Array | undefined): string | undefined => (b ? dec.decode(b) : undefined);

describe("parseFastImport", () => {
  test("single blob + commit with modify", () => {
    const stream =
      "blob\nmark :1\ndata 5\nhello\n" +
      "commit refs/heads/main\nmark :2\ncommitter C <c@example.com> 0 +0000\ndata 3\nmsg\nM 100644 :1 a.md\n\n";

    const commits = parseFastImport(stream);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.ref).toBe("refs/heads/main");
    expect(commits[0]?.message).toBe("msg");
    expect(commits[0]?.changes).toHaveLength(1);
    const change = commits[0]?.changes[0];
    expect(change?.type).toBe("modify");
    if (change?.type === "modify") {
      expect(change.path).toBe("a.md");
      expect(change.mode).toBe("100644");
      expect(change.dataref).toBe(":1");
      expect(asText(change.content)).toBe("hello");
    }
  });

  test("multiple modifications in one commit", () => {
    const stream =
      "blob\nmark :1\ndata 1\nA\n" +
      "blob\nmark :2\ndata 1\nB\n" +
      "blob\nmark :3\ndata 1\nC\n" +
      "commit refs/heads/main\ndata 1\nm\n" +
      "M 100644 :1 a.md\nM 100644 :2 b.md\nM 100644 :3 c.md\n\n";

    const [commit] = parseFastImport(stream);
    expect(commit?.changes).toHaveLength(3);
    expect(commit?.changes.map((c) => (c.type === "modify" ? c.path : null))).toEqual(["a.md", "b.md", "c.md"]);
    expect(commit?.changes.map((c) => (c.type === "modify" ? asText(c.content) : null))).toEqual(["A", "B", "C"]);
  });

  test("delete operations", () => {
    const stream = "commit refs/heads/main\ndata 1\nm\nD gone.md\nD also.md\n\n";
    const [commit] = parseFastImport(stream);
    expect(commit?.changes).toEqual([
      { type: "delete", path: "gone.md" },
      { type: "delete", path: "also.md" },
    ]);
  });

  test("mixed modify + delete", () => {
    const stream =
      "blob\nmark :1\ndata 2\nhi\n" + "commit refs/heads/main\ndata 1\nm\nM 100644 :1 new.md\nD old.md\n\n";
    const [commit] = parseFastImport(stream);
    expect(commit?.changes).toHaveLength(2);
    expect(commit?.changes[0]?.type).toBe("modify");
    expect(commit?.changes[1]?.type).toBe("delete");
  });

  test("multiple commits in one stream", () => {
    const stream =
      "blob\nmark :1\ndata 1\nA\n" +
      "commit refs/heads/main\nmark :2\ndata 3\nfst\nM 100644 :1 a.md\n\n" +
      "blob\nmark :3\ndata 1\nB\n" +
      "commit refs/heads/main\nmark :4\ndata 3\nsnd\nfrom :2\nM 100644 :3 b.md\n\n";

    const commits = parseFastImport(stream);
    expect(commits).toHaveLength(2);
    expect(commits[0]?.message).toBe("fst");
    expect(commits[1]?.message).toBe("snd");
    expect(commits[1]?.from).toBe(":2");
  });

  test("blob content with embedded newlines", () => {
    const payload = "line1\nline2\nline3";
    const stream = `blob\nmark :1\ndata ${payload.length}\n${payload}\ncommit refs/heads/main\ndata 1\nm\nM 100644 :1 a.md\n\n`;
    const [commit] = parseFastImport(stream);
    const c = commit?.changes[0];
    expect(c?.type).toBe("modify");
    if (c?.type === "modify") expect(asText(c.content)).toBe(payload);
  });

  test("large content: length-prefix parsing respects exact byte count", () => {
    const payload = "x".repeat(50_000);
    const stream = `blob\nmark :1\ndata ${payload.length}\n${payload}\ncommit refs/heads/main\ndata 1\nm\nM 100644 :1 big.md\n\n`;
    const [commit] = parseFastImport(stream);
    const c = commit?.changes[0];
    expect(c?.type).toBe("modify");
    if (c?.type === "modify") {
      expect(c.content?.length).toBe(50_000);
      expect(asText(c.content)).toBe(payload);
    }
  });

  test("binary blob bytes are preserved exactly", () => {
    // A synthetic "PNG": bytes outside valid UTF-8 (0xFF 0xFE 0x00) plus a literal LF.
    const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x0a, 0x42]);
    const header = new TextEncoder().encode(`blob\nmark :1\ndata ${payload.length}\n`);
    const trailer = new TextEncoder().encode("\ncommit refs/heads/main\ndata 1\nm\nM 100644 :1 logo.png\n\n");
    const stream = new Uint8Array(header.length + payload.length + trailer.length);
    stream.set(header, 0);
    stream.set(payload, header.length);
    stream.set(trailer, header.length + payload.length);

    const [commit] = parseFastImport(stream);
    const c = commit?.changes[0];
    expect(c?.type).toBe("modify");
    if (c?.type === "modify") {
      expect(c.content).toEqual(payload);
    }
  });

  test("inline modify carries its own data block", () => {
    const stream = "commit refs/heads/main\ndata 1\nm\n" + "M 100644 inline inl.md\ndata 5\nhello\n\n";
    const [commit] = parseFastImport(stream);
    const c = commit?.changes[0];
    expect(c?.type).toBe("modify");
    if (c?.type === "modify") {
      expect(c.path).toBe("inl.md");
      expect(c.mode).toBe("100644");
      expect(c.dataref).toBe("inline");
      expect(asText(c.content)).toBe("hello");
    }
  });

  test("quoted path with escapes", () => {
    const stream = 'commit refs/heads/main\ndata 1\nm\nD "with\\nnewline.md"\nD "spa ce.md"\n\n';
    const [commit] = parseFastImport(stream);
    expect(commit?.changes[0]).toEqual({ type: "delete", path: "with\nnewline.md" });
    expect(commit?.changes[1]).toEqual({ type: "delete", path: "spa ce.md" });
  });

  test("rename and copy ops are swallowed, not fatal", () => {
    const stream = "commit refs/heads/main\ndata 1\nm\nR old.md new.md\nC src.md dst.md\n\n";
    const commits = parseFastImport(stream);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.changes).toEqual([]);
  });

  test("deleteall is a first-class change, preceding subsequent modifies", () => {
    const stream =
      "blob\nmark :1\ndata 1\nA\n" + "commit refs/heads/main\ndata 1\nm\ndeleteall\nM 100644 :1 fresh.md\n\n";
    const [commit] = parseFastImport(stream);
    expect(commit?.changes).toHaveLength(2);
    expect(commit?.changes[0]).toEqual({ type: "deleteall" });
    expect(commit?.changes[1]?.type).toBe("modify");
  });

  test("filedeleteall alias is recognized", () => {
    const stream = "commit refs/heads/main\ndata 1\nm\nfiledeleteall\n\n";
    const [commit] = parseFastImport(stream);
    expect(commit?.changes).toEqual([{ type: "deleteall" }]);
  });

  test("reset directive between commits is tolerated", () => {
    const stream = "reset refs/heads/main\nfrom :1\n" + "commit refs/heads/main\ndata 1\nm\nD a.md\n\n";
    const commits = parseFastImport(stream);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.changes).toEqual([{ type: "delete", path: "a.md" }]);
  });

  test("utf-8 content byte length", () => {
    const payload = "héllo"; // 6 bytes in UTF-8
    const byteLen = new TextEncoder().encode(payload).length;
    const stream = `blob\nmark :1\ndata ${byteLen}\n${payload}\ncommit refs/heads/main\ndata 1\nm\nM 100644 :1 a.md\n\n`;
    const [commit] = parseFastImport(stream);
    const c = commit?.changes[0];
    if (c?.type === "modify") expect(asText(c.content)).toBe(payload);
  });

  test("original-oid lines are ignored in blob and commit headers", () => {
    const stream =
      "blob\nmark :1\noriginal-oid abc123\ndata 1\nA\n" +
      "commit refs/heads/main\nmark :2\noriginal-oid def456\nauthor A <a@a> 0 +0000\ndata 1\nm\nM 100644 :1 a.md\n\n";
    const [commit] = parseFastImport(stream);
    expect(commit?.author).toBe("A <a@a> 0 +0000");
    const c = commit?.changes[0];
    if (c?.type === "modify") expect(asText(c.content)).toBe("A");
  });

  test("tag directives are swallowed, not treated as commits", () => {
    const stream =
      "tag v1\nfrom :2\noriginal-oid deadbeef\ntagger T <t@t> 0 +0000\ndata 8\nreleased\n" +
      "commit refs/heads/main\ndata 1\nm\nD a.md\n\n";
    const commits = parseFastImport(stream);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.changes).toEqual([{ type: "delete", path: "a.md" }]);
  });

  test("signed tag with PGP signature block is fully consumed", () => {
    const stream =
      "tag v1\n" +
      "from :2\n" +
      "tagger T <t@t> 0 +0000\n" +
      "-----BEGIN PGP SIGNATURE-----\n" +
      "iQFzBAABCgAdFiEEabc\n" +
      "-----END PGP SIGNATURE-----\n" +
      "data 8\nreleased\n" +
      "commit refs/heads/main\ndata 1\nm\nD a.md\n\n";
    const commits = parseFastImport(stream);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.changes).toEqual([{ type: "delete", path: "a.md" }]);
  });

  test("data <<DELIM here-doc preserves trailing newline", () => {
    const stream = "commit refs/heads/main\ndata <<END\nhello\nworld\nEND\nM 100644 inline x.md\ndata 1\nq\n\n";
    const [commit] = parseFastImport(stream);
    // Every git commit message terminates with \n — the here-doc form must
    // preserve it so re-serializing yields identical SHAs.
    expect(commit?.message).toBe("hello\nworld\n");
    const c = commit?.changes[0];
    if (c?.type === "modify") expect(asText(c.content)).toBe("q");
  });

  test("merge lines are captured", () => {
    const stream = "commit refs/heads/main\ndata 1\nm\nfrom :1\nmerge :2\nmerge :3\n\n";
    const [commit] = parseFastImport(stream);
    expect(commit?.merge).toEqual([":2", ":3"]);
  });

  test("malformed M line with missing fields is dropped", () => {
    const stream = "commit refs/heads/main\ndata 1\nm\nM 100644only\n\n";
    const [commit] = parseFastImport(stream);
    expect(commit?.changes).toEqual([]);
  });

  test("quoted path octal and hex escapes", () => {
    const stream = 'commit refs/heads/main\ndata 1\nm\nD "a\\101\\x42c.md"\n\n';
    const [commit] = parseFastImport(stream);
    // \101 = octal 65 = 'A', \x42 = hex 66 = 'B'
    expect(commit?.changes[0]).toEqual({ type: "delete", path: "aABc.md" });
  });

  test("invalid data length throws", () => {
    expect(() => parseFastImport("blob\nmark :1\ndata NaN\nfoo\n")).toThrow(/invalid data length/);
  });

  test("data length exceeding stream throws", () => {
    expect(() => parseFastImport("blob\nmark :1\ndata 9999\nshort\n")).toThrow(/exceeds stream/);
  });

  test("missing data header throws", () => {
    expect(() => parseFastImport("commit refs/heads/main\nM 100644 inline x.md\nfoo\n")).toThrow(/expected "data"/);
  });

  test("comment lines are skipped", () => {
    const stream = "# a comment\ncommit refs/heads/main\ndata 1\nm\nD a.md\n\n";
    const [commit] = parseFastImport(stream);
    expect(commit?.changes).toEqual([{ type: "delete", path: "a.md" }]);
  });

  test("round-trip: real git fast-export", () => {
    const dir = mkdtempSync(join(tmpdir(), "fast-import-parser-"));
    // Strip GIT_* env vars so git commands can't escape the scratch repo via
    // an inherited GIT_DIR / GIT_WORK_TREE and scribble on the parent.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
    }
    try {
      const run = (args: string[], opts: { input?: string } = {}) => {
        const r = spawnSync("git", args, { cwd: dir, input: opts.input, encoding: "utf-8", env });
        if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
        return r.stdout;
      };

      run(["init", "-q", "-b", "main"]);
      run(["config", "user.email", "t@t.t"]);
      run(["config", "user.name", "T"]);

      writeFileSync(join(dir, "a.md"), "alpha\n");
      writeFileSync(join(dir, "b.md"), "beta\n");
      run(["add", "-A"]);
      run(["commit", "-q", "-m", "first"]);

      writeFileSync(join(dir, "a.md"), "alpha-v2\n");
      rmSync(join(dir, "b.md"));
      writeFileSync(join(dir, "c.md"), "gamma\n");
      run(["add", "-A"]);
      run(["commit", "-q", "-m", "second"]);

      const stream = run(["fast-export", "--all"]);
      const commits = parseFastImport(stream);

      expect(commits).toHaveLength(2);

      const [first, second] = commits;
      // Git terminates every commit message with \n — don't .trim() it away;
      // re-serializing a trimmed message would yield a different SHA.
      expect(first?.message).toBe("first\n");
      expect(
        first?.changes
          .filter((c) => c.type === "modify")
          .map((c) => (c as { path: string }).path)
          .sort(),
      ).toEqual(["a.md", "b.md"]);
      const firstA = first?.changes.find((c) => c.type === "modify" && c.path === "a.md");
      expect(firstA?.type).toBe("modify");
      if (firstA?.type === "modify") expect(asText(firstA.content)).toBe("alpha\n");

      expect(second?.message).toBe("second\n");
      const byPath = new Map(second?.changes.map((c) => [c.type === "modify" || c.type === "delete" ? c.path : "", c]));
      const secA = byPath.get("a.md");
      expect(secA?.type).toBe("modify");
      if (secA?.type === "modify") expect(asText(secA.content)).toBe("alpha-v2\n");
      expect(byPath.get("b.md")).toEqual({ type: "delete", path: "b.md" });
      const secC = byPath.get("c.md");
      expect(secC?.type).toBe("modify");
      if (secC?.type === "modify") expect(asText(secC.content)).toBe("gamma\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
