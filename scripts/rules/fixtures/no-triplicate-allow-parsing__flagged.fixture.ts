/**
 * @rule no-triplicate-allow-parsing
 * @expect 1
 * @path packages/command/src/commands/spawn-args.ts
 *
 * Re-implementing the paren-match regex outside the canonical module
 * should be flagged.
 */

export function parseAllow(rawAllow: string[]): string[] {
  for (const pattern of rawAllow) {
    const parenMatch = pattern.match(/^(\w+)\((.+)\)$/);
    if (parenMatch) {
      console.warn(`dead pattern: ${pattern}`);
    }
  }
  return rawAllow;
}
