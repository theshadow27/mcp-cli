import { describe, expect, test } from "bun:test";
import { hasFrontmatter, injectFrontmatter, stripFrontmatter } from "./frontmatter";

describe("injectFrontmatter", () => {
  test("injects frontmatter into plain content", () => {
    const result = injectFrontmatter("Hello world", { id: "123", title: "My Page" });
    expect(result).toBe("---\nid: 123\ntitle: My Page\n---\n\nHello world");
  });

  test("replaces existing frontmatter", () => {
    const existing = "---\nid: old\n---\n\nContent here";
    const result = injectFrontmatter(existing, { id: "new", version: 2 });
    expect(result).toBe("---\nid: new\nversion: 2\n---\n\nContent here");
  });

  test("quotes strings with special YAML characters", () => {
    const result = injectFrontmatter("body", { url: "https://example.com/pages/123" });
    expect(result).toContain('"https://example.com/pages/123"');
  });

  test("omits null and undefined fields", () => {
    const result = injectFrontmatter("body", { id: "1", url: undefined, extra: null });
    expect(result).not.toContain("url");
    expect(result).not.toContain("extra");
    expect(result).toContain("id: 1");
  });

  test("handles numbers and booleans", () => {
    const result = injectFrontmatter("body", { version: 42, active: true });
    expect(result).toContain("version: 42");
    expect(result).toContain("active: true");
  });

  test("handles empty content", () => {
    const result = injectFrontmatter("", { id: "1" });
    expect(result).toBe("---\nid: 1\n---\n\n");
  });
});

describe("stripFrontmatter", () => {
  test("strips frontmatter and returns fields", () => {
    const input = "---\nid: page-abc\nversion: 5\n---\n\nPage body here";
    const { content, fields } = stripFrontmatter(input);
    expect(content).toBe("Page body here");
    expect(fields).toEqual({ id: "page-abc", version: 5 });
  });

  test("returns original content when no frontmatter", () => {
    const input = "Just plain content\nno frontmatter";
    const { content, fields } = stripFrontmatter(input);
    expect(content).toBe("Just plain content\nno frontmatter");
    expect(fields).toBeNull();
  });

  test("parses quoted string values", () => {
    const input = '---\nurl: "https://example.com/path"\n---\n\nContent';
    const { fields } = stripFrontmatter(input);
    expect(fields?.url).toBe("https://example.com/path");
  });

  test("parses boolean values", () => {
    const input = "---\nactive: true\narchived: false\n---\n\n";
    const { fields } = stripFrontmatter(input);
    expect(fields?.active).toBe(true);
    expect(fields?.archived).toBe(false);
  });

  test("parses inline array values", () => {
    const input = "---\ntags: [a, b, c]\n---\n\nContent";
    const { fields } = stripFrontmatter(input);
    expect(fields?.tags).toEqual(["a", "b", "c"]);
  });

  test("round-trips inject → strip cleanly", () => {
    const original = "# My Page\n\nSome content here.";
    const fm = { id: "abc-123", version: 7, space: "TEST", title: "My Page" };
    const injected = injectFrontmatter(original, fm);
    const { content, fields } = stripFrontmatter(injected);
    expect(content).toBe(original);
    expect(fields?.id).toBe("abc-123");
    expect(fields?.version).toBe(7);
  });
});

describe("hasFrontmatter", () => {
  test("returns true when content has id field", () => {
    expect(hasFrontmatter("---\nid: 123\ntitle: Test\n---\n\nContent")).toBe(true);
  });

  test("returns false when no frontmatter", () => {
    expect(hasFrontmatter("Plain content without frontmatter")).toBe(false);
  });

  test("returns false when frontmatter has no id field", () => {
    expect(hasFrontmatter("---\ntitle: No ID here\n---\n\nContent")).toBe(false);
  });
});
