import { describe, expect, test } from "bun:test";
import { RETIRED_COMMANDS, cmdRetired } from "./retired";

function capture(name: string): { code: number; out: string } {
  const lines: string[] = [];
  const code = cmdRetired(name, { error: (msg) => lines.push(msg) });
  return { code, out: lines.join("\n") };
}

describe("cmdRetired", () => {
  test("mcx scope exits non-zero", () => {
    expect(capture("scope").code).not.toBe(0);
  });

  test("names mcx domain as the replacement verb for verb", () => {
    const { out } = capture("scope");
    expect(out).toContain("mcx domain add");
    expect(out).toContain("mcx domain ls");
    expect(out).toContain("mcx domain rm");
  });

  test("says where scopes registered before the upgrade went", () => {
    const { out } = capture("scope");
    expect(out).toContain("imported as domains");
    // The sidecars are deliberately left on disk — the message must not imply otherwise.
    expect(out).toContain("~/.mcp-cli/scopes");
  });

  test("an unknown command is still an error, not a crash", () => {
    expect(capture("definitely-not-retired").code).not.toBe(0);
  });

  test("every retired command names a replacement and at least one verb", () => {
    for (const [name, retired] of Object.entries(RETIRED_COMMANDS)) {
      expect(retired.replacement.length, `${name} replacement`).toBeGreaterThan(0);
      expect(retired.verbs.length, `${name} verbs`).toBeGreaterThan(0);
      for (const [old, replacement] of retired.verbs) {
        expect(old, `${name} old verb`).toContain(`mcx ${name}`);
        expect(replacement, `${name} new verb`).not.toContain(`mcx ${name} `);
      }
    }
  });
});
