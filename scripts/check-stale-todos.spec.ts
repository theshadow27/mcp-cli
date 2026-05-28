import { describe, expect, it } from "bun:test";

import { extractTodoRefs } from "./check-stale-todos";

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
    // The pattern requires whitespace after dotw-todo, so dotw-todo-<more> doesn't match.
    // Construct the content with a template to avoid the scanner seeing a literal pattern.
    const ident = ["dotw-todo", "needs-issue"].join("-");
    const content = `// ${ident} is the rule documented in #2352`;
    const refs = extractTodoRefs(content, "packages/foo/bar.ts");
    expect(refs).toHaveLength(0);
  });
});
