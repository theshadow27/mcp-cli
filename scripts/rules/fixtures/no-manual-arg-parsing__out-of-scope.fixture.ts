/**
 * @rule no-manual-arg-parsing
 * @expect 0
 * @path packages/command/src/parse.ts
 *
 * Files outside packages/command/src/commands/ are not scoped by this rule.
 * Helper files like parse.ts legitimately use manual arg indexing.
 */

export function extractSomeFlag(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--some") {
      const next = args[i + 1];
      if (next) i++;
    }
  }
}
