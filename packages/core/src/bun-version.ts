import { compareVersions } from "./upgrade";

export const MIN_BUN_VERSION = "1.2.18";

/**
 * Exits with a clear error if the running Bun version is older than minVersion.
 * Call this at the top of each entry-point main() before any other work.
 */
export function assertBunVersion(minVersion: string = MIN_BUN_VERSION): void {
  const current = Bun.version;
  if (compareVersions(current, minVersion) > 0) {
    process.stderr.write(
      `error: mcp-cli requires Bun >=${minVersion}, found ${current}\n  upgrade with: bun upgrade\n`,
    );
    process.exit(1);
  }
}
