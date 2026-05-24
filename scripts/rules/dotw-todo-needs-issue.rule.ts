import type { CheckRule } from "./_engine/rule";

const TODO_RE = /\/\/\s*dotw-todo\s+([\w-]+)\s*:\s*(.+)$/;
const ISSUE_RE = /#\d+/;

const rule: CheckRule = {
  id: "dotw-todo-needs-issue",
  kind: "check",
  scold: "dotw-todo suppression comment is missing a #<number> issue reference",
  guidance: [
    "every dotw-todo must reference a tracking issue: // dotw-todo <rule>: <desc> — fix in #NNN",
    "if no issue exists yet, create one with `gh issue create` before adding the suppression",
  ],
  documentation: "#2352",
  check({ file, violated }) {
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      const m = TODO_RE.exec(line);
      if (!m) continue;
      const matchIdx = line.indexOf(m[0]);
      const preceding = matchIdx > 0 ? line[matchIdx - 1] : undefined;
      if (preceding !== undefined && !/\s/.test(preceding)) continue;
      if (ISSUE_RE.test(m[2] ?? "")) continue;
      violated(i + 1, matchIdx + 1, line.trim());
    }
  },
};

export default rule;
