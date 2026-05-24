/**
 * @rule cli-surface-registered
 * @expect 0
 * @path packages/command/src/main.ts
 *
 * Every dispatch case appears in SUBCOMMANDS — no violations.
 */

declare let command: string;

const SUBCOMMANDS = ["ls", "call", "info", "grep", "status"] as const;

switch (command) {
  case "ls":
    break;
  case "call":
    break;
  case "info":
    break;
  case "grep":
    break;
  case "status":
    break;
}
