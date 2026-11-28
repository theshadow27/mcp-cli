import { describe, expect, it } from "bun:test";
import { testRule } from "am-i-done";

import { loadScenario } from "./_spec-harness";
import rule, { extractForwardHandler } from "./agent-protocol-forward-symmetry.rule";

describe("extractForwardHandler", () => {
  it("extracts the event param type and session:* cases", () => {
    const src = `function forwardSessionEvent(sessionId: string, event: AgentSessionEvent): void {
      switch (event.type) {
        case "session:init": break;
        case "session:ended": break;
        case "db:noise": break;
      }
    }`;
    const h = extractForwardHandler(src);
    expect(h?.paramType).toBe("AgentSessionEvent");
    expect(h?.cases).toEqual(["session:ended", "session:init"]);
  });

  it("returns undefined when there is no forwardSessionEvent", () => {
    expect(extractForwardHandler("function other() {}")).toBeUndefined();
  });

  it("ignores cases in comments", () => {
    const src = `function forwardSessionEvent(sessionId: string, event: AgentSessionEvent): void {
      switch (event.type) {
        case "session:init": break;
        // case "session:ended": break;
        /* case "session:cleared": break; */
      }
    }`;
    expect(extractForwardHandler(src)?.cases).toEqual(["session:init"]);
  });

  it("reads a generic parameter type and a multi-line signature", () => {
    const src = `function forwardSessionEvent(
      sessionId: string,
      event: Extract<AgentSessionEvent, { type: string }>,
    ): void {
      switch (event.type) {
        case "session:init": break;
      }
    }`;
    const h = extractForwardHandler(src);
    expect(h?.paramType).toBe("Extract<AgentSessionEvent, { type: string }>");
    expect(h?.cases).toEqual(["session:init"]);
  });

  it("reports an untyped event parameter as an empty type", () => {
    const src = `function forwardSessionEvent(sessionId, event) { switch (event.type) { case "session:init": break; } }`;
    expect(extractForwardHandler(src)?.paramType).toBe("");
  });
});

describe("check over its scenario fixtures", () => {
  for (const scenario of [
    "asymmetric",
    "asymmetric-three",
    "comment-and-noise",
    "different-types",
    "lone-anchor",
    "symmetric",
  ]) {
    it(scenario, async () => {
      const { files, expected } = loadScenario(rule.id, scenario);
      const found = await testRule(rule, files);
      const counts = Object.fromEntries(Object.keys(expected).map((path) => [path, 0]));
      for (const f of found) counts[f.file] = (counts[f.file] ?? 0) + 1;
      expect(counts).toEqual(expected);
    });
  }
});
