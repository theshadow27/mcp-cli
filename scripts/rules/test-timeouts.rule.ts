/**
 * Rule: test-timeouts
 *
 * Flag `setTimeout` and `Bun.sleep` calls with literal numeric delays in
 * *.spec.ts / *.test.ts files. Fixed-delay waits in tests are flaky and
 * environment-dependent — they pass on a fast laptop and fail in CI, or
 * vice-versa.
 *
 * Detection tracks parenthesis depth across the whole file content so
 * multi-line calls (`setTimeout(\n  r,\n  50,\n)`) are matched correctly.
 * For `setTimeout`, the *second* positional argument is the delay (not
 * the last) — `setTimeout(fn, 50, extra)` is flagged.
 *
 * Safe alternatives:
 *   - poll with a deadline (e.g. pollUntil / expect.poll)
 *   - inject a FakeClock for timer-dependent behavior
 *   - pass a named constant or parameter delay (e.g. `Bun.sleep(intervalMs)`)
 *
 * Suppression: `// dotw-ignore test-timeouts: <reason>` on the call line.
 *
 * Migrated from the standalone `scripts/check-test-timeouts.ts`.
 */

import type { CheckRule } from "./_engine/rule";

function extractDelayArg(args: string): string | null {
  let depth = 0;
  let firstComma = -1;
  let secondComma = -1;
  for (let j = 0; j < args.length; j++) {
    const c = args[j];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      if (firstComma === -1) firstComma = j;
      else {
        secondComma = j;
        break;
      }
    }
  }
  if (firstComma === -1) return null;
  return args.slice(firstComma + 1, secondComma === -1 ? undefined : secondComma).trim();
}

interface RawViolation {
  line: number;
  text: string;
}

export function findSetTimeoutViolations(content: string): RawViolation[] {
  const results: RawViolation[] = [];
  const lines = content.split("\n");
  const re = /\bsetTimeout\s*\(/g;

  for (let match = re.exec(content); match !== null; match = re.exec(content)) {
    const parenOpen = match.index + match[0].length - 1;
    let depth = 1;
    let i = parenOpen + 1;
    while (i < content.length && depth > 0) {
      if (content[i] === "(") depth++;
      else if (content[i] === ")") depth--;
      i++;
    }
    if (depth !== 0) continue;

    const args = content.slice(parenOpen + 1, i - 1);
    const delayArg = extractDelayArg(args);
    if (delayArg === null || !/^[0-9][0-9_]*$/.test(delayArg)) continue;

    const lineNum = content.slice(0, match.index).split("\n").length;
    results.push({ line: lineNum, text: (lines[lineNum - 1] ?? "").trim() });
  }
  return results;
}

export function findBunSleepViolations(content: string): RawViolation[] {
  const results: RawViolation[] = [];
  const lines = content.split("\n");
  const re = /\bBun\.sleep\s*\(/g;

  for (let match = re.exec(content); match !== null; match = re.exec(content)) {
    const parenOpen = match.index + match[0].length - 1;
    let depth = 1;
    let i = parenOpen + 1;
    while (i < content.length && depth > 0) {
      if (content[i] === "(") depth++;
      else if (content[i] === ")") depth--;
      i++;
    }
    if (depth !== 0) continue;

    const arg = content.slice(parenOpen + 1, i - 1).trim();
    if (!/^[0-9][0-9_]*$/.test(arg)) continue;

    const lineNum = content.slice(0, match.index).split("\n").length;
    results.push({ line: lineNum, text: (lines[lineNum - 1] ?? "").trim() });
  }
  return results;
}

const rule: CheckRule = {
  id: "test-timeouts",
  kind: "check",
  appliesToTests: true,
  scold: "setTimeout / Bun.sleep with a fixed numeric delay in a test — flaky, environment-dependent wait",
  guidance: [
    "Bad:   await new Promise((r) => setTimeout(r, 50))",
    "Good:  await pollUntil(() => condition(), { timeout: 5000 })",
    "Bad:   await Bun.sleep(50) // then assert",
    "Good:  inject a FakeClock or pass a configurable delay parameter (e.g. Bun.sleep(intervalMs))",
    "named constants and parameters are fine: setTimeout(r, POLL_INTERVAL), Bun.sleep(remaining)",
  ],
  documentation: "test/CLAUDE.md flaky-test prevention",
  check({ file, violated }) {
    // Standalone parity: original check-test-timeouts.ts globbed **/*.spec.ts only,
    // so .test.ts files (e.g. scripts/bun-segfault-repro/repro.test.ts) were never
    // scanned. Preserve that exact surface here — broaden in a separate PR if desired.
    if (!file.relPath.endsWith(".spec.ts") && !file.relPath.endsWith(".spec.tsx")) return;

    for (const v of findSetTimeoutViolations(file.content)) {
      violated(v.line, 1, v.text);
    }
    for (const v of findBunSleepViolations(file.content)) {
      violated(v.line, 1, v.text);
    }
  },
};

export default rule;
