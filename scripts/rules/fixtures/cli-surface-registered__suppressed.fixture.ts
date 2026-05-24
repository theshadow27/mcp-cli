/**
 * @rule cli-surface-registered
 * @expect 0
 * @path packages/command/src/main.ts
 *
 * "deprecated" is missing from SUBCOMMANDS but suppressed — no violation.
 */

declare let command: string;

const SUBCOMMANDS = ["ls", "call"] as const;

switch (command) {
  case "ls":
    break;
  case "call":
    break;
  // dotw-ignore cli-surface-registered: deprecated; use `mcx agent <provider>`
  case "deprecated":
    break;
}
