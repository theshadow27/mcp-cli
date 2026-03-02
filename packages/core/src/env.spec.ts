import { describe, expect, it } from "bun:test";
import { expandEnvVars, expandEnvVarsDeep } from "./env.js";

describe("expandEnvVars", () => {
  const env = { FOO: "bar", API_KEY: "secret123" };

  it("expands simple variables", () => {
    expect(expandEnvVars("${FOO}", env)).toBe("bar");
    expect(expandEnvVars("prefix-${FOO}-suffix", env)).toBe("prefix-bar-suffix");
  });

  it("expands with defaults", () => {
    expect(expandEnvVars("${MISSING:-fallback}", env)).toBe("fallback");
    expect(expandEnvVars("${FOO:-fallback}", env)).toBe("bar");
  });

  it("throws on missing vars in strict mode", () => {
    expect(() => expandEnvVars("${NOPE}", env, true)).toThrow("NOPE");
  });

  it("preserves original in non-strict mode", () => {
    expect(expandEnvVars("${NOPE}", env, false)).toBe("${NOPE}");
  });

  it("handles multiple vars in one string", () => {
    expect(expandEnvVars("${FOO}:${API_KEY}", env)).toBe("bar:secret123");
  });

  it("handles no vars", () => {
    expect(expandEnvVars("plain string", env)).toBe("plain string");
  });
});

describe("expandEnvVarsDeep", () => {
  const env = { KEY: "val" };

  it("expands strings in objects", () => {
    expect(expandEnvVarsDeep({ a: "${KEY}", b: 42 }, env)).toEqual({ a: "val", b: 42 });
  });

  it("expands strings in arrays", () => {
    expect(expandEnvVarsDeep(["${KEY}", "plain"], env)).toEqual(["val", "plain"]);
  });

  it("expands nested objects", () => {
    expect(expandEnvVarsDeep({ env: { TOKEN: "${KEY}" } }, env)).toEqual({
      env: { TOKEN: "val" },
    });
  });
});
