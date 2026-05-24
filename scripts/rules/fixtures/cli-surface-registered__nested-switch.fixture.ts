/**
 * @rule cli-surface-registered
 * @expect 0
 * @path packages/command/src/main.ts
 *
 * Inner switch inside a handler must NOT trigger false positives even when
 * it uses the SAME discriminant (`command`) as the outer dispatch switch.
 * The isNested guard — not just the expression filter — prevents "kill" and
 * "status" from being required in SUBCOMMANDS.
 */

declare let command: string;

const SUBCOMMANDS = ["serve", "config"] as const;

switch (command) {
  case "serve":
    switch (command) {
      case "kill":
        break;
      case "status":
        break;
    }
    break;
  case "config":
    break;
}
