/**
 * @rule args-bounds
 * @expect 0
 * @path packages/command/src/commands/example-safe.ts
 *
 * All four currently-detected safe patterns plus algebraic equivalents.
 * The rule should NOT fire on any of these.
 */

declare const args: string[];

export function nullCoalescing(): void {
  let i = 0;
  // Rule 1: null coalescing on the same line.
  const from = args[++i] ?? null;
  console.log(from);
}

export function truthyPreCheck(): void {
  let i = 0;
  // Rule 2: truthy pre-check on preceding line.
  if (args[i + 1]) {
    const cloudId = args[++i];
    console.log(cloudId);
  }
}

export function truthyPreCheckMultiLine(): void {
  let i = 0;
  // Rule 2 extension: multi-line if block (issue #1967).
  if (
    args[i + 1] &&
    args[i + 2]
  ) {
    const val = args[++i];
    console.log(val);
  }
}

export function explicitBoundsCheck(): void {
  let i = 0;
  // Rule 3: explicit bounds comparison on preceding line.
  if (i + 1 >= args.length) throw new Error("missing value");
  const rawReason = args[++i];
  console.log(rawReason);
}

export function sameLineTernary(): void {
  let i = 0;
  // Rule 3: same-line ternary bounds check.
  const val = i + 1 < args.length ? args[++i] : null;
  console.log(val);
}

export function altBoundsForm(): void {
  let i = 0;
  // Rule 3 algebraic equivalent (issue #1969): `i < args.length - 1`.
  if (i < args.length - 1) {
    const val = args[++i];
    console.log(val);
  }
}

export function altBoundsReversed(): void {
  let i = 0;
  // Rule 3 algebraic equivalent: `args.length - 1 > i`.
  if (args.length - 1 > i) {
    const val = args[++i];
    console.log(val);
  }
}

export function postCheckBang(): void {
  let i = 0;
  // Rule 4: post-check on assigned variable via !val.
  const val = args[++i];
  if (!val) throw new Error("missing");
  console.log(val);
}

export function postCheckUndefined(): void {
  let i = 0;
  // Rule 4: post-check via === undefined.
  const val = args[++i];
  if (val === undefined) throw new Error("missing");
  console.log(val);
}

export function postCheckNullish(): void {
  let i = 0;
  // Rule 4: post-check via == null.
  const val = args[++i];
  if (val == null) throw new Error("missing");
  console.log(val);
}
