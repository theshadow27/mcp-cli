import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type IssueFetcher, type TodoRef, checkRefs, extractTodoRefs, scanFiles } from "./check-stale-todos";

// Build dotw-todo test strings programmatically so this spec file doesn't
// contain literal `// dotw-todo <rule>: ... #NNN` patterns. If it did,
// `check-stale-todos.ts`'s `scanFiles()` would pick them up and call `gh
// issue view` on fake issue numbers — producing false positives in CI.
function makeTodo(ruleId: string, desc: string): string {
  return ["//", "dotw-todo", `${ruleId}:`, desc].join(" ");
}

describe("extractTodoRefs", () => {
  it("extracts a single issue number from a standard dotw-todo comment", () => {
    const content = [makeTodo("prod-empty-catch", "legacy path — fix in #2496"), "badCode();"].join("\n");
    const refs = extractTodoRefs(content, "packages/foo/bar.ts");
    expect(refs).toHaveLength(1);
    expect(refs[0]?.file).toBe("packages/foo/bar.ts");
    expect(refs[0]?.line).toBe(1);
    expect(refs[0]?.issueNumbers).toEqual([2496]);
    expect(refs[0]?.snippet).toBe(makeTodo("prod-empty-catch", "legacy path — fix in #2496"));
  });

  it("extracts multiple issue numbers from the same comment", () => {
    const content = makeTodo("some-rule", "blocked on #1234 and #5678 landing first");
    const refs = extractTodoRefs(content, "packages/foo/bar.ts");
    expect(refs).toHaveLength(1);
    expect(refs[0]?.issueNumbers).toEqual([1234, 5678]);
  });

  it("skips dotw-todo inside a string literal (double quote preceding //)", () => {
    const content = `const msg = "${makeTodo("some-rule", "legacy path — fix in #999")}";`;
    const refs = extractTodoRefs(content, "packages/foo/bar.ts");
    expect(refs).toHaveLength(0);
  });

  it("skips dotw-todo inside a string literal (single quote preceding //)", () => {
    const content = `const msg = '${makeTodo("some-rule", "legacy path — fix in #999")}';`;
    const refs = extractTodoRefs(content, "packages/foo/bar.ts");
    expect(refs).toHaveLength(0);
  });

  it("skips dotw-todo inside a template literal (backtick preceding //)", () => {
    const bt = String.fromCharCode(96); // backtick — avoids a real template literal in this file
    const content = ["const msg = ", bt, makeTodo("some-rule", "legacy path — fix in #999"), bt, ";"].join("");
    const refs = extractTodoRefs(content, "packages/foo/bar.ts");
    expect(refs).toHaveLength(0);
  });

  it("skips dotw-todo with no issue number", () => {
    const content = makeTodo("some-rule", "needs cleanup eventually");
    const refs = extractTodoRefs(content, "packages/foo/bar.ts");
    expect(refs).toHaveLength(0);
  });

  it("handles trailing-style suppression comment (// after code)", () => {
    const content = `doSomething(); ${makeTodo("no-raw-spawn", "migrate to spawnSync — fix in #1111")}`;
    const refs = extractTodoRefs(content, "packages/foo/bar.ts");
    expect(refs).toHaveLength(1);
    expect(refs[0]?.issueNumbers).toEqual([1111]);
    expect(refs[0]?.line).toBe(1);
  });

  it("collects refs from multiple lines", () => {
    const content = [
      makeTodo("rule-a", "first — fix in #101"),
      "code();",
      makeTodo("rule-b", "second — fix in #202"),
    ].join("\n");
    const refs = extractTodoRefs(content, "packages/foo/bar.ts");
    expect(refs).toHaveLength(2);
    expect(refs[0]?.issueNumbers).toEqual([101]);
    expect(refs[0]?.line).toBe(1);
    expect(refs[1]?.issueNumbers).toEqual([202]);
    expect(refs[1]?.line).toBe(3);
  });

  it("returns empty array for a file with no dotw-todo comments", () => {
    const content = "export const x = 1;\n// dotw-ignore some-rule: permanent exception\n";
    const refs = extractTodoRefs(content, "packages/foo/bar.ts");
    expect(refs).toHaveLength(0);
  });

  it("skips identifiers like dotw-todo-needs-issue that contain dotw-todo as a substring", () => {
    const ident = ["dotw-todo", "needs-issue"].join("-");
    const content = `// ${ident} is the rule documented in #2352`;
    const refs = extractTodoRefs(content, "packages/foo/bar.ts");
    expect(refs).toHaveLength(0);
  });
});

describe("scanFiles", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "stale-todos-"));
    await mkdir(join(tmpRoot, "packages", "foo"), { recursive: true });
    await mkdir(join(tmpRoot, "scripts"), { recursive: true });
    await mkdir(join(tmpRoot, "test"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("finds dotw-todo refs in packages/ files", async () => {
    await writeFile(join(tmpRoot, "packages", "foo", "bar.ts"), `${makeTodo("some-rule", "fix in #42")}\n`);
    const refs = await scanFiles(tmpRoot);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.issueNumbers).toEqual([42]);
    expect(refs[0]?.file).toBe("packages/foo/bar.ts");
  });

  it("excludes .rule.ts and fixture files", async () => {
    await mkdir(join(tmpRoot, "scripts", "rules", "fixtures"), { recursive: true });
    await writeFile(join(tmpRoot, "scripts", "rules", "my.rule.ts"), `${makeTodo("r", "fix in #1")}\n`);
    await writeFile(join(tmpRoot, "scripts", "rules", "fixtures", "x.ts"), `${makeTodo("r", "fix in #2")}\n`);
    await writeFile(join(tmpRoot, "scripts", "ok.ts"), `${makeTodo("r", "fix in #3")}\n`);
    const refs = await scanFiles(tmpRoot);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.issueNumbers).toEqual([3]);
  });

  it("returns empty when no dotw-todo refs exist", async () => {
    await writeFile(join(tmpRoot, "packages", "foo", "clean.ts"), "export const x = 1;\n");
    const refs = await scanFiles(tmpRoot);
    expect(refs).toHaveLength(0);
  });
});

describe("checkRefs", () => {
  let stdoutBuf: string;
  let stderrBuf: string;
  // Injected sinks — capture into local buffers instead of monkeypatching the
  // process-global streams (which would swallow other modules' output in the
  // shared `bun test` process and break the stream write-callback contract).
  const out = (s: string) => {
    stdoutBuf += s;
  };
  const err = (s: string) => {
    stderrBuf += s;
  };

  beforeEach(() => {
    stdoutBuf = "";
    stderrBuf = "";
  });

  const ref = (issueNumbers: number[], file = "f.ts", line = 1): TodoRef => ({
    file,
    line,
    issueNumbers,
    snippet: `snippet for ${issueNumbers.join(",")}`,
  });

  it("returns 0 with no refs", async () => {
    const code = await checkRefs([], async () => "OPEN", out, err);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("no dotw-todo issue references found");
  });

  it("returns 1 when all issues are unreachable (fail-closed)", async () => {
    const code = await checkRefs([ref([100])], async () => null, out, err);
    expect(code).toBe(1);
    expect(stderrBuf).toContain("could not reach GitHub API");
    expect(stderrBuf).toContain("1 issue unreachable");
  });

  it("returns 1 when a referenced issue is CLOSED", async () => {
    const code = await checkRefs([ref([200], "pkg/foo.ts", 5)], async (n) => (n === 200 ? "CLOSED" : "OPEN"), out, err);
    expect(code).toBe(1);
    expect(stderrBuf).toContain("#200 (CLOSED)");
    expect(stderrBuf).toContain("pkg/foo.ts:5");
  });

  it("returns 0 when all referenced issues are OPEN", async () => {
    const code = await checkRefs([ref([300])], async () => "OPEN", out, err);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("all referenced issues open");
  });

  it("warns but continues when some (not all) issues are unreachable", async () => {
    const code = await checkRefs([ref([400]), ref([401])], async (n) => (n === 400 ? null : "OPEN"), out, err);
    expect(code).toBe(0);
    expect(stderrBuf).toContain("#400");
    expect(stderrBuf).toContain("skipped");
  });

  it("fetches each unique issue only once", async () => {
    const calls: number[] = [];
    const fetcher: IssueFetcher = async (n) => {
      calls.push(n);
      return "OPEN";
    };
    await checkRefs([ref([500]), ref([500, 501])], fetcher, out, err);
    expect(calls.sort()).toEqual([500, 501]);
  });

  it("reports multiple stale refs in one run", async () => {
    const code = await checkRefs([ref([600], "a.ts", 10), ref([601], "b.ts", 20)], async () => "CLOSED", out, err);
    expect(code).toBe(1);
    expect(stderrBuf).toContain("2 dotw-todo comments reference closed issues");
    expect(stderrBuf).toContain("a.ts:10");
    expect(stderrBuf).toContain("b.ts:20");
  });
});
