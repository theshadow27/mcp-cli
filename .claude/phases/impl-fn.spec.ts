import { describe, expect, test } from "bun:test";
import { buildImplPrompt } from "./impl-fn";

describe("buildImplPrompt", () => {
  test("includes the issue number", () => {
    const prompt = buildImplPrompt(42, null);
    expect(prompt).toContain("42");
  });

  test("contains /implement skill invocation", () => {
    expect(buildImplPrompt(42, null)).toMatch(/^\/implement 42/);
  });

  test("omits resolve step when prNumber is null", () => {
    const prompt = buildImplPrompt(42, null);
    expect(prompt).not.toContain("resolve");
  });

  test("includes resolve step when prNumber is provided", () => {
    const prompt = buildImplPrompt(42, 30);
    expect(prompt).toContain("mcx pr comments 30 resolve --all-addressed");
  });

  test("resolve step references the correct pr number", () => {
    expect(buildImplPrompt(10, 99)).toContain("mcx pr comments 99 resolve --all-addressed");
  });
});
