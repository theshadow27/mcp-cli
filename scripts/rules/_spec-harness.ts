/**
 * Runs a text-only check rule over one of its scenario fixtures, in a spec. The engine runs every
 * fixture on each `doing-it-wrong` sweep; this exists so `bun test --coverage` (and the coverage
 * ratchet) also sees the rule's `check` run, which the package has no public API for. Rules that
 * call `ctx.ast()` or `ctx.graph()` are out of scope here, and suppressions are not applied.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckRule, FileMeta, RuleContext, Verdict } from "am-i-done";

const DIRECTIVE = /^\s*(?:\/\/+|#|--|<!--|\/\*+|\*)\s*@(expect|path)\s+(\S+)/;

export interface FixtureResult {
  /** Per file the rule checked: violations found and the count its fixture expects. */
  files: { path: string; found: number; expected: number }[];
}

function meta(path: string, content: string): FileMeta {
  return {
    path: `/fixture/${path}`,
    relativePath: path,
    ext: path.slice(path.lastIndexOf(".") + 1),
    content,
    isTest: /\.(?:spec|test)\.[^/.]+$/.test(path),
    imports: [],
  };
}

/** Load `fixtures/<rule>__<scenario>/` and run `rule.check` on each of its files. */
export function runScenario(rule: CheckRule, scenario: string): FixtureResult {
  const dir = join(import.meta.dir, "fixtures", `${rule.id}__${scenario}`);
  const files = new Map<string, FileMeta>();
  const expected = new Map<string, number>();
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
    files.set(path, meta(path, lines.join("\n")));
    expected.set(path, expect);
  }
  const checkedToken = { checked: true } as unknown as Verdict;
  const result: FixtureResult = { files: [] };
  for (const file of files.values()) {
    let found = 0;
    const ctx = {
      file,
      files,
      violated: () => void found++,
      checked: () => checkedToken,
      skipped: () => ({ checked: false }) as unknown as Verdict,
      ast: () => {
        throw new Error("runScenario does not parse");
      },
      graph: () => {
        throw new Error("runScenario builds no import graph");
      },
    } satisfies RuleContext;
    if (rule.check(ctx) === checkedToken)
      result.files.push({ path: file.relativePath, found, expected: expected.get(file.relativePath) ?? 0 });
  }
  return result;
}
