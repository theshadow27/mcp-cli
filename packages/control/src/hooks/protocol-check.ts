import { PROTOCOL_VERSION, ProtocolMismatchError } from "@mcp-cli/core";

/**
 * Check if the daemon's protocolVersion matches the local PROTOCOL_VERSION.
 * Returns an error message if mismatched, or null if OK.
 */
export function checkProtocolVersion(daemonVersion: string | undefined): string | null {
  if (daemonVersion && daemonVersion !== PROTOCOL_VERSION) {
    return new ProtocolMismatchError(daemonVersion, PROTOCOL_VERSION).message;
  }
  return null;
}
