/**
 * @rule acp-cost-tracking-evidence
 * @expect 0
 * @path packages/core/src/agent-provider.ts
 *
 * ACP providers with costTracking: false are not flagged.
 * Non-ACP providers with costTracking: true are not flagged.
 */

declare function registerProvider(spec: unknown): void;

registerProvider({
  name: "copilot",
  serverName: "_acp",
  native: {
    worktree: false,
    costTracking: false,
  },
});

registerProvider({
  name: "opencode",
  serverName: "_opencode",
  native: {
    worktree: false,
    costTracking: true,
  },
});
