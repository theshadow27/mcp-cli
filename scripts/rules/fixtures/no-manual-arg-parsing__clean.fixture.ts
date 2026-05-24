/**
 * @rule no-manual-arg-parsing
 * @expect 0
 * @path packages/command/src/commands/example-clean.ts
 *
 * Commands using parseFlags() and standard extract*Flag helpers
 * should NOT be flagged.
 */

import { parseFlags } from "../flags";
import { extractJsonFlag, extractVerboseFlag } from "../parse";

export function cleanCommand(args: string[]): void {
  const { json, rest } = extractJsonFlag(args);
  const { verbose, rest: r2 } = extractVerboseFlag(rest);

  const result = parseFlags(r2, {
    output: { type: "string", alias: "o" },
    count: { type: "number", alias: "n" },
    force: { type: "boolean", alias: "f" },
  });

  console.log(json, verbose, result);
}

export function positionalOnly(args: string[]): void {
  for (const arg of args) {
    console.log(arg);
  }
}
