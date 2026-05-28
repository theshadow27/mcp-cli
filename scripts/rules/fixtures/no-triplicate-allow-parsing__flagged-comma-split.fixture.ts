/**
 * @rule no-triplicate-allow-parsing
 * @expect 1
 * @path packages/command/src/commands/spawn-args.ts
 *
 * Comma-splitting raw allow values with dead-pattern context should be
 * flagged — exercises signal-3 (comma-split) in isolation.
 */

export function normalizeAllow(raw: string[]): string[] {
  return raw.flatMap((v) => v.split(",").filter((p) => !isDeadPattern(p)));
}

declare function isDeadPattern(p: string): boolean;
