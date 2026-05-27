/**
 * @rule capability-flag-handler
 * @expect 2
 * @path packages/core/src/agent-provider.ts
 *
 * Provider claims costTracking and compactLog but the fixture file set
 * contains no session files — both flags are unexercised.
 */

function registerProvider(_p: unknown): void {}

registerProvider({
	name: "broken-provider",
	serverName: "_broken",
	toolPrefix: "broken",
	buildSpawnArgs: () => ({}),
	native: {
		costTracking: true,
		compactLog: true,
	},
});
