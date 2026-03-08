import { PROTOCOL_VERSION } from "@mcp-cli/core";

/**
 * Check if the daemon's protocolVersion matches the local PROTOCOL_VERSION.
 * Returns an error message if mismatched, or null if OK.
 */
export function checkProtocolVersion(daemonVersion: string | undefined): string | null {
  if (daemonVersion && daemonVersion !== PROTOCOL_VERSION) {
    return `Protocol version mismatch — daemon is running ${daemonVersion}, mcpctl expects ${PROTOCOL_VERSION}.\n\nThe daemon was started from a different build.\n\n  To restart:  mcx daemon restart`;
  }
  return null;
}
