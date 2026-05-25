/**
 * @rule args-bounds
 * @expect 0
 * @path packages/command/src/commands/example-suppressed.ts
 *
 * Engine-boundary `// dotw-ignore args-bounds: <reason>` suppression
 * applies to the line itself and the preceding line. Both placements
 * should silence the rule.
 */

declare const args: string[];

export function trailingSuppression(): void {
  let i = 0;
  // dotw-ignore args-bounds: helper verifies bounds internally
  const val = args[++i];
  console.log(val);
}

export function leadingSuppression(): void {
  let i = 0;
  const val = args[++i]; // dotw-ignore args-bounds: helper verifies bounds internally
  console.log(val);
}
