/**
 * Transitional deprecation warning for the `mcp` → `mcx` rename.
 */

/**
 * Check if the CLI was invoked via the deprecated `mcp` name and warn on stderr.
 * Returns true if the deprecated name was detected.
 */
export function checkDeprecatedName(argv1: string): boolean {
  const base = argv1.split("/").pop() ?? "";
  if (base === "mcp" || base === "mcp.exe") {
    console.error(
      'Warning: "mcp" has been renamed to "mcx". Please update your scripts. "mcp" will be removed in a future release.',
    );
    return true;
  }
  return false;
}
