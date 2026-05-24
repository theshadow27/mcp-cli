/**
 * @rule cli-surface-registered
 * @expect 1
 * @path packages/command/src/main.ts
 *
 * "info" is in dispatch but missing from SUBCOMMANDS — one violation.
 */

declare let command: string;

const SUBCOMMANDS = ["ls", "call"] as const;

switch (command) {
  case "ls":
    break;
  case "call":
    break;
  case "info":
    break;
}
