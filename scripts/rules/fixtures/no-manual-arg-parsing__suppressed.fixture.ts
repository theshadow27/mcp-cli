/**
 * @rule no-manual-arg-parsing
 * @expect 0
 * @path packages/command/src/commands/example-suppressed.ts
 *
 * A dotw-todo comment suppresses the violation while migration is in
 * progress.
 */

export function legacyParser(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name") {
      // dotw-todo no-manual-arg-parsing: migrate to parseFlags — fix in #2250
      const val = args[++i];
      console.log(val);
    }
  }
}
