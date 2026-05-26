/**
 * @rule capability-flag-handler
 * @expect 0
 * @path packages/core/src/agent-provider.ts
 *
 * Provider declares costTracking: false — no handler needed, no violation.
 */

function registerProvider(_p: unknown): void {}

registerProvider({
	name: "safe-provider",
	serverName: "_safe",
	toolPrefix: "safe",
	buildSpawnArgs: () => ({}),
	native: {
		costTracking: false,
		compactLog: false,
	},
});
