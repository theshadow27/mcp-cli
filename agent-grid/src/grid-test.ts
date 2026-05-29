import type { AgentFeatures, AgentProvider } from "@mcp-cli/core";

/** Outcome of a single grid test execution. */
export type GridResult = { status: "pass" } | { status: "fail"; error: string } | { status: "n/a"; reason: string };

/** Context provided to each grid test's run function. */
export interface GridTestContext {
  provider: AgentProvider;
  cwd: string;
  onCleanup?: (fn: () => Promise<void>) => void;
}

/** A single capability test in the agent grid. */
export interface GridTest {
  name: string;
  requires: (keyof AgentFeatures)[];
  run(ctx: GridTestContext): Promise<GridResult>;
}
