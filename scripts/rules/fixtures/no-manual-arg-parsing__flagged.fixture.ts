/**
 * @rule no-manual-arg-parsing
 * @expect 5
 * @path packages/command/src/commands/example.ts
 *
 * Hand-rolled flag parsing patterns that should be detected:
 * args[++i], args[i + 1], argv.shift(), and variants using allArgs.
 */

declare const args: string[];
declare const argv: string[];
declare const allArgs: string[];

export function parseExample(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--output") {
      const val = args[++i];
      console.log(val);
    } else if (arg === "--repo") {
      const next = args[i + 1];
      if (next) i++;
    }
  }
}

export function shiftExample(argv: string[]): void {
  while (argv.length > 0) {
    const flag = argv.shift();
    if (flag === "--verbose") break;
  }
}

export function callbackExample(allArgs: string[], i: number): void {
  const v1 = allArgs[++i];
  const v2 = allArgs[i + 1];
  console.log(v1, v2);
}
