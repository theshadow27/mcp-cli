import { compareVersions } from "./upgrade";

export const MIN_BUN_VERSION = "1.2.18";

/**
 * Exits with a clear error if the running Bun version is older than minVersion.
 * Call this at the top of each entry-point main() before any other work.
 *
 * @param current - injectable for testing; defaults to Bun.version
 */
export function assertBunVersion(minVersion: string = MIN_BUN_VERSION, current: string = Bun.version): void {
  // Strip pre-release/build metadata: 1.2.18-canary.X satisfies >=1.2.18.
  const currentBase = current.split(/[-+]/)[0];
  // compareVersions(a, b) returns positive if b > a (see upgrade.ts JSDoc — non-standard).
  // So > 0 here means minVersion > currentBase, i.e. the running Bun is too old.
  if (compareVersions(currentBase, minVersion) > 0) {
    process.stderr.write(
      `error: mcp-cli requires Bun >=${minVersion}, found ${current}\n  upgrade with: bun upgrade\n`,
    );
    process.exit(1);
  }
}
