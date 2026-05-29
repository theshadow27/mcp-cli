import type { AgentFeatures, AgentProvider } from "@mcp-cli/core";
import type { GridResult, GridTest } from "./grid-test.js";

/** Check which required features a provider lacks. */
export function missingFeatures(provider: AgentProvider, requires: (keyof AgentFeatures)[]): (keyof AgentFeatures)[] {
  return requires.filter((f) => provider.native[f] !== true);
}

/**
 * Gate a test against a provider's capabilities.
 * Returns a skip result if the provider lacks any required feature,
 * or null if the test should proceed.
 */
export function gateTest(test: GridTest, provider: AgentProvider): GridResult | null {
  if (test.requires.length === 0) return null;

  const missing = missingFeatures(provider, test.requires);
  if (missing.length === 0) return null;

  return {
    status: "n/a",
    reason: `provider "${provider.name}" lacks: ${missing.join(", ")}`,
  };
}
