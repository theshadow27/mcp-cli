import type { PatternRule } from "./_engine/rule";

const rule: PatternRule = {
  id: "no-skip-permissions-flag",
  kind: "pattern",
  appliesToTests: false,
  scold: "spawn flag that disables permission checks entirely — mcx must never hand a child an ungated session",
  // `--dangerously-skip-permissions`, and `bypassPermissions` as a
  // `--permission-mode` value, both mean "run every tool with no gate at all".
  // Neither can ever be correct on the spawn path: `auto` delegates to the
  // child's classifier, `default` keeps the daemon-side gate, and those are the
  // only two postures the daemon knows how to reason about (#3119).
  pattern: /--dangerously-skip-permissions|\bbypassPermissions\b/,
  except: ["// dotw-ignore no-skip-permissions-flag:", "// dotw-todo no-skip-permissions-flag:"],
  guidance: [
    "use `--permission-mode auto` (child's auto-mode classifier gates) or `--permission-mode default` (daemon gates via can_use_tool)",
    "resolve the mode through `resolvePermissionMode()` — never hardcode it at the spawn site",
    "pre-approving specific tools is `--allowedTools`, which is narrow and reviewable; skipping permissions wholesale is not",
    "documenting the flag rather than emitting it? suppress with `// dotw-ignore no-skip-permissions-flag: <reason>`",
  ],
  documentation: "#3119",
};

export default rule;
