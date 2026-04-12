import { describe, expect, test } from "bun:test";
import { type PhaseSource, parseSource, rejectionForInstall } from "./phase-source";

const MANIFEST_DIR = "/workspace/myproj";
const HASH = "a".repeat(64);

describe("parseSource — file kind", () => {
  test("resolves relative path against manifestDir", () => {
    const r = parseSource("./scripts/implement.ts", MANIFEST_DIR);
    expect(r).toEqual({ kind: "file", absPath: "/workspace/myproj/scripts/implement.ts" });
  });

  test("resolves parent-relative path within manifestDir", () => {
    const r = parseSource("./sub/../x.ts", MANIFEST_DIR);
    expect(r).toEqual({ kind: "file", absPath: "/workspace/myproj/x.ts" });
  });

  test("rejects relative path escaping manifestDir", () => {
    const r = parseSource("../shared/x.ts", MANIFEST_DIR);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.reason).toMatch(/escapes manifest directory/);
  });

  test("rejects deep traversal", () => {
    const r = parseSource("../../../etc/passwd", MANIFEST_DIR);
    expect(r.kind).toBe("error");
  });

  test("passes absolute path through as-is", () => {
    const r = parseSource("/abs/path.ts", MANIFEST_DIR);
    expect(r).toEqual({ kind: "file", absPath: "/abs/path.ts" });
  });

  test("parses file:// URI", () => {
    const r = parseSource("file:///abs/path.ts", MANIFEST_DIR);
    expect(r).toEqual({ kind: "file", absPath: "/abs/path.ts" });
  });

  test("decodes percent-encoded file:// path", () => {
    const r = parseSource("file:///abs/my%20phase.ts", MANIFEST_DIR);
    expect(r).toEqual({ kind: "file", absPath: "/abs/my phase.ts" });
  });

  test("rejects file:// with relative path", () => {
    const r = parseSource("file://relative.ts", MANIFEST_DIR);
    expect(r.kind).toBe("error");
  });

  test("rejects file:// with malformed percent-encoding", () => {
    const r = parseSource("file:///tmp/%ZZ.ts", MANIFEST_DIR);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.reason).toMatch(/malformed percent-encoding/);
  });

  test("rejects file:// with unencoded '#'", () => {
    const r = parseSource("file:///notes#draft.ts", MANIFEST_DIR);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.reason).toMatch(/unencoded/);
  });

  test("rejects file:// with unencoded '?'", () => {
    const r = parseSource("file:///notes?x.ts", MANIFEST_DIR);
    expect(r.kind).toBe("error");
  });

  test("accepts file:// with percent-encoded '#'", () => {
    const r = parseSource("file:///notes%23draft.ts", MANIFEST_DIR);
    expect(r).toEqual({ kind: "file", absPath: "/notes#draft.ts" });
  });

  test("rejects relative path when manifestDir is not absolute", () => {
    const r = parseSource("./x.ts", "relative/dir");
    expect(r.kind).toBe("error");
  });
});

describe("parseSource — github kind (parsed, not installable)", () => {
  test("parses full github form", () => {
    const r = parseSource(`github:owner/repo/pkg/phase.ts@v1.2.3#sha256=${HASH}`, MANIFEST_DIR);
    expect(r).toEqual({
      kind: "github",
      owner: "owner",
      repo: "repo",
      path: "pkg/phase.ts",
      version: "v1.2.3",
      hash: HASH,
    });
  });

  test("parses github with single-segment path", () => {
    const r = parseSource(`github:o/r/p.ts@v1#sha256=${HASH}`, MANIFEST_DIR);
    expect(r.kind).toBe("github");
    if (r.kind === "github") expect(r.path).toBe("p.ts");
  });

  test("rejects github without integrity hash", () => {
    const r = parseSource("github:o/r/p.ts@v1", MANIFEST_DIR);
    expect(r.kind).toBe("error");
  });

  test("rejects github with malformed hash", () => {
    const r = parseSource("github:o/r/p.ts@v1#sha256=nothex", MANIFEST_DIR);
    expect(r.kind).toBe("error");
  });

  test("rejects github without @version", () => {
    const r = parseSource(`github:o/r/p.ts#sha256=${HASH}`, MANIFEST_DIR);
    expect(r.kind).toBe("error");
  });

  test("rejects github missing path", () => {
    const r = parseSource(`github:o/r@v1#sha256=${HASH}`, MANIFEST_DIR);
    expect(r.kind).toBe("error");
  });

  test("rejects github with '@' in path (ambiguous version split)", () => {
    const r = parseSource(`github:o/r/path@v2/module.ts@v1#sha256=${HASH}`, MANIFEST_DIR);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.reason).toMatch(/multiple '@'/);
  });

  test("rejects github version containing '/'", () => {
    // Only reachable if `@` is only once but version has `/`
    const r = parseSource(`github:o/r/p.ts@v1/extra#sha256=${HASH}`, MANIFEST_DIR);
    expect(r.kind).toBe("error");
  });
});

describe("parseSource — https kind (parsed, not installable)", () => {
  test("parses https with integrity", () => {
    const r = parseSource(`https://example.com/phase.ts#sha256=${HASH}`, MANIFEST_DIR);
    expect(r).toEqual({ kind: "https", url: "https://example.com/phase.ts", hash: HASH });
  });

  test("rejects https without integrity", () => {
    const r = parseSource("https://example.com/phase.ts", MANIFEST_DIR);
    expect(r.kind).toBe("error");
  });

  test("rejects http:// (insecure)", () => {
    const r = parseSource(`http://example.com/phase.ts#sha256=${HASH}`, MANIFEST_DIR);
    expect(r.kind).toBe("error");
  });
});

describe("parseSource — malformed", () => {
  test("rejects empty string", () => {
    expect(parseSource("", MANIFEST_DIR).kind).toBe("error");
  });

  test("rejects unknown scheme", () => {
    expect(parseSource("ftp://x/y.ts", MANIFEST_DIR).kind).toBe("error");
  });

  test("rejects bare name without ./ prefix", () => {
    expect(parseSource("phase.ts", MANIFEST_DIR).kind).toBe("error");
  });
});

describe("rejectionForInstall", () => {
  test("returns null for file sources", () => {
    expect(rejectionForInstall({ kind: "file", absPath: "/x.ts" })).toBeNull();
  });

  test("rejects github sources at install time", () => {
    const src: PhaseSource = { kind: "github", owner: "o", repo: "r", path: "p.ts", version: "v1", hash: HASH };
    expect(rejectionForInstall(src)).toBe("remote sources not yet supported");
  });

  test("rejects https sources at install time", () => {
    const src: PhaseSource = { kind: "https", url: "https://example.com/x.ts", hash: HASH };
    expect(rejectionForInstall(src)).toBe("remote sources not yet supported");
  });
});
