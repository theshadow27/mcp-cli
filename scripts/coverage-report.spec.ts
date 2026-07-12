import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RAN_FILES_RE,
  checkSpecCountFloor,
  countExpectedSpecFiles,
  formatDegradedRunError,
  formatExclusionList,
  parseDiscoveredFileCount,
} from "./coverage-report";

describe("parseDiscoveredFileCount", () => {
  test("parses the bun end-of-run summary", () => {
    expect(parseDiscoveredFileCount("Ran 6158 tests across 225 files. [57.07s]")).toBe(225);
  });

  test("handles singular 'test' and 'file'", () => {
    expect(parseDiscoveredFileCount("Ran 1 test across 1 file. [1.00ms]")).toBe(1);
  });

  test("finds the line embedded in larger output", () => {
    const out = "bun test v1.3.14\n 612 pass\n 0 fail\nRan 612 tests across 26 files. [6.96s]\n";
    expect(parseDiscoveredFileCount(out)).toBe(26);
  });

  test("returns null when the summary line is absent", () => {
    expect(parseDiscoveredFileCount("no summary here")).toBeNull();
  });

  test("only matches at line start (not mid-line quotes)", () => {
    expect(parseDiscoveredFileCount("logged `Ran 5 tests across 3 files` inside a string")).toBeNull();
  });

  test("RAN_FILES_RE is exported for reuse", () => {
    expect("Ran 10 tests across 4 files.").toMatch(RAN_FILES_RE);
  });
});

describe("countExpectedSpecFiles", () => {
  function makeFixture(): string {
    const root = mkdtempSync(join(tmpdir(), "cov-report-"));
    mkdirSync(join(root, "pkg/src/nested"), { recursive: true });
    mkdirSync(join(root, "other"), { recursive: true });
    writeFileSync(join(root, "pkg/src/a.spec.ts"), "");
    writeFileSync(join(root, "pkg/src/b.spec.tsx"), "");
    writeFileSync(join(root, "pkg/src/nested/c.spec.ts"), "");
    writeFileSync(join(root, "pkg/src/impl.ts"), ""); // non-spec, ignored
    writeFileSync(join(root, "other/loose.spec.ts"), "");
    writeFileSync(join(root, "other/not-a-spec.ts"), "");
    return root;
  }

  test("recurses directories and counts spec files only", () => {
    const root = makeFixture();
    try {
      expect(countExpectedSpecFiles(["pkg/src"], root)).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("counts an explicit spec-file path as 1, ignores non-spec file paths", () => {
    const root = makeFixture();
    try {
      expect(countExpectedSpecFiles(["other/loose.spec.ts", "other/not-a-spec.ts"], root)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dedupes a file already covered by a directory path", () => {
    const root = makeFixture();
    try {
      // pkg/src (3 specs) + explicit a.spec.ts already inside it → still 3
      expect(countExpectedSpecFiles(["pkg/src", "pkg/src/a.spec.ts"], root)).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores missing paths", () => {
    const root = makeFixture();
    try {
      expect(countExpectedSpecFiles(["does/not/exist"], root)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checkSpecCountFloor", () => {
  test("passes when discovered equals expected", () => {
    const r = checkSpecCountFloor("Ran 100 tests across 225 files.", 225);
    expect(r.ok).toBe(true);
    expect(r.discovered).toBe(225);
  });

  test("passes when discovered exceeds expected (one-sided)", () => {
    expect(checkSpecCountFloor("Ran 100 tests across 230 files.", 225).ok).toBe(true);
  });

  test("fails closed when discovered drops below expected", () => {
    const r = checkSpecCountFloor("Ran 100 tests across 26 files.", 225);
    expect(r.ok).toBe(false);
    expect(r.discovered).toBe(26);
    expect(r.reason).toContain("expected >= 225");
  });

  test("fails closed when the summary line is unparseable", () => {
    const r = checkSpecCountFloor("garbage output, bun changed its format", 225);
    expect(r.ok).toBe(false);
    expect(r.discovered).toBeNull();
    expect(r.reason).toContain("failing closed");
  });
});

describe("formatDegradedRunError", () => {
  test("reports the discovered/expected mismatch and suppression + re-run guidance", () => {
    const r = checkSpecCountFloor("Ran 100 tests across 221 files.", 315);
    const lines = formatDegradedRunError(r);
    const joined = lines.join("\n");
    expect(joined).toContain("Suspected worker crash");
    expect(joined).toContain("221 discovered < 315 expected");
    expect(joined).toContain("unreliable and have been suppressed");
    expect(joined).toContain("Re-run");
    expect(joined).toContain("#2759");
  });

  test("renders '?' for an unparseable summary (null discovered)", () => {
    const r = checkSpecCountFloor("bun changed its output format", 315);
    const joined = formatDegradedRunError(r).join("\n");
    expect(joined).toContain("? discovered < 315 expected");
  });
});

describe("formatExclusionList", () => {
  test("itemizes path — reason pairs", () => {
    const lines = formatExclusionList({
      "core/src/ipc-client.ts": "IPC transport requires running daemon",
      "test/harness.ts": "Test infrastructure, not source",
    });
    expect(lines).toEqual([
      "  core/src/ipc-client.ts — IPC transport requires running daemon",
      "  test/harness.ts — Test infrastructure, not source",
    ]);
  });

  test("returns an empty list for no exclusions", () => {
    expect(formatExclusionList({})).toEqual([]);
  });
});
