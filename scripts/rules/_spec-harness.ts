/**
 * Loads one of a rule's scenario fixtures for a spec, so `bun test --coverage` (and the coverage
 * ratchet) sees the rule's `check` run; the engine runs the same fixtures on every sweep. The rule
 * itself runs through the package's `testRule`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIRECTIVE = /^\s*(?:\/\/+|#|--|<!--|\/\*+|\*)\s*@(expect|path)\s+(\S+)/;

export interface Scenario {
  /** Each file at the path the rule should believe, with its directives blanked. */
  files: Record<string, string>;
  /** Each file's `@expect` (default 0). */
  expected: Record<string, number>;
}

/** `fixtures/<ruleId>__<scenario>/`, as the engine reads it. */
export function loadScenario(ruleId: string, scenario: string): Scenario {
  const dir = join(import.meta.dir, "fixtures", `${ruleId}__${scenario}`);
  const result: Scenario = { files: {}, expected: {} };
  for (const rel of new Bun.Glob("**/*.fixture").scanSync({ cwd: dir, dot: true })) {
    const lines = readFileSync(join(dir, rel), "utf8").split("\n");
    let path = rel.slice(0, -".fixture".length);
    let expect = 0;
    lines.slice(0, 20).forEach((line, i) => {
      const m = DIRECTIVE.exec(line);
      if (!m) return;
      if (m[1] === "expect") expect = Number(m[2]);
      else path = m[2] as string;
      lines[i] = "";
    });
    result.files[path] = lines.join("\n");
    result.expected[path] = expect;
  }
  return result;
}
