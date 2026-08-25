/**
 * Tombstones for removed commands.
 *
 * A retired command keeps a dispatch entry that fails loudly and names its replacement,
 * including the verb-for-verb mapping. Falling through to the generic "unknown command"
 * costs the reader a search of the changelog to learn that the feature still exists under
 * another name; a tombstone costs them nothing and is deleted a release later.
 */

import { c } from "../output";

export interface RetiredCommand {
  /** What replaced it, in one line. */
  replacement: string;
  /** Verb-for-verb mapping, `old` → `new`. Rendered in the order given. */
  verbs: Array<[string, string]>;
  /** Anything the user needs to know about data the retired command left behind. */
  note?: string;
}

export const RETIRED_COMMANDS: Record<string, RetiredCommand> = {
  scope: {
    replacement: "`mcx scope` was removed in v2.0.0 — use `mcx domain`, which supersedes it.",
    verbs: [
      ["mcx scope init [name]", "mcx domain add <name> [host:]<path>"],
      ["mcx scope ls", "mcx domain ls"],
      ["mcx scope rm <name>", "mcx domain rm <name>"],
    ],
    note: "Scopes registered before the upgrade were imported as domains on the first daemon start — run `mcx domain ls` to see them. The old `~/.mcp-cli/scopes/*.json` files are left on disk untouched.",
  },
};

export interface RetiredDeps {
  /** Sink for every line, including the headline. Defaults to stderr. */
  error?: (msg: string) => void;
}

/** `printError`'s wire format, applied to a line this function routes through `deps.error`. */
function errorLine(message: string): string {
  return `${c.red}Error${c.reset}: ${message}`;
}

/**
 * Print the tombstone for `name` and return the process exit code (always non-zero).
 *
 * Returns the code rather than calling `process.exit` so the message is testable without
 * a subprocess; the caller in `main.ts` owns the exit.
 */
export function cmdRetired(name: string, deps: RetiredDeps = {}): number {
  const error = deps.error ?? ((msg: string) => console.error(msg));
  const retired = RETIRED_COMMANDS[name];
  if (!retired) {
    error(errorLine(`Unknown command: ${name}`));
    return 1;
  }

  error(errorLine(retired.replacement));
  const width = Math.max(...retired.verbs.map(([old]) => old.length));
  for (const [old, replacement] of retired.verbs) {
    error(`  ${old.padEnd(width)}  →  ${replacement}`);
  }
  if (retired.note) error(`\n${retired.note}`);
  return 1;
}
