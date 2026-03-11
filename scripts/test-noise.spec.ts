import { describe, expect, it } from "bun:test";
import { detectTestNoise } from "./test-noise";

describe("detectTestNoise", () => {
  it("detects [mcpd] prefixed lines", () => {
    const output = "some test output\n[mcpd] starting server\n✓ test passed\n";
    expect(detectTestNoise(output)).toEqual(["[mcpd] starting server"]);
  });

  it("detects [_claude] prefixed lines", () => {
    const output = "[_claude] session started\n";
    expect(detectTestNoise(output)).toEqual(["[_claude] session started"]);
  });

  it("detects [_aliases] prefixed lines", () => {
    const output = "[_aliases] loading aliases\n";
    expect(detectTestNoise(output)).toEqual(["[_aliases] loading aliases"]);
  });

  it("detects [alias-*] prefixed lines", () => {
    const output = "[alias-foo] running\n[alias-bar_baz] done\n";
    expect(detectTestNoise(output)).toEqual(["[alias-foo] running", "[alias-bar_baz] done"]);
  });

  it("detects MCPD_READY", () => {
    const output = "starting\nMCPD_READY\ndone\n";
    expect(detectTestNoise(output)).toEqual(["MCPD_READY"]);
  });

  it("returns empty for clean test output", () => {
    const output = "✓ test 1\n✓ test 2\n2 pass\n";
    expect(detectTestNoise(output)).toEqual([]);
  });

  it("handles multiple noise patterns in one output", () => {
    const output = ["MCPD_READY", "[mcpd] connected", "✓ some test", "[_claude] ws open", "[_aliases] loaded 3"].join(
      "\n",
    );
    expect(detectTestNoise(output)).toHaveLength(4);
  });

  it("trims whitespace before matching", () => {
    const output = "  MCPD_READY  \n  [mcpd] foo  \n";
    expect(detectTestNoise(output)).toEqual(["MCPD_READY", "[mcpd] foo"]);
  });

  it("does not match MCPD_READY as substring", () => {
    const output = "got MCPD_READY signal\nMCPD_READY\n";
    expect(detectTestNoise(output)).toEqual(["MCPD_READY"]);
  });
});
