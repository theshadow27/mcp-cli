/**
 * @rule cli-surface-registered
 * @expect 0
 * @path packages/command/src/main.ts
 *
 * Inner switch inside a handler must NOT trigger false positives.
 * Only the outer dispatch switch is checked — "kill" and "status"
 * inside the nested switch are not required in SUBCOMMANDS.
 */

declare let command: string;
declare let subcommand: string;

const SUBCOMMANDS = ["serve", "config"] as const;

switch (command) {
  case "serve":
    switch (subcommand) {
      case "kill":
        break;
      case "status":
        break;
    }
    break;
  case "config":
    break;
}
