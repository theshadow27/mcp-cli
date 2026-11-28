import type { Rule } from "am-i-done";

export default {
  id: "no-skip-permissions-flag",
  type: "pattern",
  category: "architecture",
  tests: "exclude",
  // The flag and the mode value are strings in spawn argv, and the old rule read raw lines, so it
  // saw string literals and comments alike.
  scope: "all",
  scold: "spawn flag that disables permission checks entirely — mcx must never hand a child an ungated session",
  // `--dangerously-skip-permissions`, and `bypassPermissions` as a
  // `--permission-mode` value, both mean "run every tool with no gate at all".
  // Neither can ever be correct on the spawn path: `auto` delegates to the
  // child's classifier, `default` keeps the daemon-side gate, and those are the
  // only two postures the daemon knows how to reason about (#3119).
  pattern: /--dangerously-skip-permissions|\bbypassPermissions\b/g,
  guidance: [
    "use `--permission-mode auto` (child's auto-mode classifier gates) or `--permission-mode default` (daemon gates via can_use_tool)",
    "resolve the mode through `resolvePermissionMode()` — never hardcode it at the spawn site",
    "pre-approving specific tools is `--allowedTools`, which is narrow and reviewable; skipping permissions wholesale is not",
    "documenting the flag rather than emitting it? suppress with `// doing-it-wrong-ignore no-skip-permissions-flag: <reason> (#issue)`",
  ],
  documentation: "#3119",
} satisfies Rule;
