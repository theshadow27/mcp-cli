/**
 * @rule no-triplicate-allow-parsing
 * @expect 0
 * @path packages/command/src/commands/spawn-args.ts
 *
 * Calling validateAllowPatterns from the shared module is the correct
 * pattern. No re-implementation of the parsing logic here.
 */

import { validateAllowPatterns } from "@mcp-cli/core";

export function parseAllow(rawAllow: string[]): string[] {
  const validation = validateAllowPatterns(rawAllow);
  return validation.patterns;
}
