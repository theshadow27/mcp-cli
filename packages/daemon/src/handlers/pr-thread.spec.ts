import { describe, expect, test } from "bun:test";
import { COPILOT_USERS, isBotNoise } from "./pr-thread";

describe("isBotNoise", () => {
  test("flags coderabbitai[bot] as noise", () => {
    expect(isBotNoise({ user: "coderabbitai[bot]", body: "some review" })).toBe(true);
  });

  test("flags robobun watermark comments as noise", () => {
    expect(isBotNoise({ user: "robobun", body: "<!-- generated-comment abc123 -->\nSome text" })).toBe(true);
  });

  test("passes Copilot through", () => {
    expect(isBotNoise({ user: "Copilot", body: "suggestion here" })).toBe(false);
  });

  test("passes copilot-pull-request-reviewer[bot] through", () => {
    expect(isBotNoise({ user: "copilot-pull-request-reviewer[bot]", body: "review" })).toBe(false);
  });

  test("passes human users through", () => {
    expect(isBotNoise({ user: "octocat", body: "LGTM" })).toBe(false);
  });

  test("passes github-actions[bot] through (not in filter)", () => {
    expect(isBotNoise({ user: "github-actions[bot]", body: "CI passed" })).toBe(false);
  });

  test("detects watermark mid-body", () => {
    expect(isBotNoise({ user: "somebot", body: "prefix <!-- generated-comment xyz --> suffix" })).toBe(true);
  });
});

describe("COPILOT_USERS", () => {
  test("includes Copilot", () => {
    expect(COPILOT_USERS.has("Copilot")).toBe(true);
  });

  test("includes copilot-pull-request-reviewer[bot]", () => {
    expect(COPILOT_USERS.has("copilot-pull-request-reviewer[bot]")).toBe(true);
  });

  test("excludes random users", () => {
    expect(COPILOT_USERS.has("octocat")).toBe(false);
  });
});
