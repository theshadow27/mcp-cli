/**
 * @rule acp-cost-tracking-evidence
 * @expect 2
 * @path packages/core/src/agent-provider.ts
 *
 * Two ACP providers with costTracking: true and no spec in the file map.
 * Both costTracking: true lines are flagged.
 */

declare function registerProvider(spec: unknown): void;

registerProvider({
  name: "grok",
  serverName: "_acp",
  native: {
    worktree: false,
    costTracking: true,
  },
});

registerProvider({
  name: "copilot",
  serverName: "_acp",
  native: {
    worktree: false,
    costTracking: true,
  },
});

registerProvider({
  name: "gemini",
  serverName: "_acp",
  native: {
    worktree: false,
    costTracking: false,
  },
});
