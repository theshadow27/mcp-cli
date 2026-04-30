import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "@mcp-cli/core";
import { registerHelp } from "./help";

registerHelp("claude spawn", {
  name: "mcx claude spawn",
  summary: "Start a new Claude Code session",
  usage: [
    'mcx claude spawn --task "description"',
    'mcx claude spawn --task "description" --allow Bash Read Write',
    'mcx claude spawn --task "description" --worktree my-feature',
    'mcx claude spawn --headed --task "description"',
  ],
  options: [
    ["--task, -t <string>", "Task prompt for the session (required unless --resume)"],
    ["--worktree, -w [name]", "Run in a git worktree for branch isolation (auto-generates name if omitted)"],
    [
      "--allow <tools...>",
      "Space-separated tool patterns to auto-approve (e.g. Bash Read Write Edit Glob Grep Skill; supports globs: mcp__grafana__*)",
    ],
    ["--headed", "Open in a visible terminal tab (via tty)"],
    ["--name, -n <name>", "Human-readable session name (auto-generated if omitted)"],
    ["--resume <id>", "Resume a previous session by ID"],
    ["--model, -m <name>", "Model: opus, sonnet, haiku, or full ID (default: opus)"],
    ["--cwd <path>", "Working directory for the session"],
    ["--wait", "Block until Claude produces a result"],
    ["--timeout <ms>", `Max wait time in ms (default: ${DEFAULT_TIMEOUT_MS}, only with --wait)`],
    ["--work-item <id>", "Work item ID (#N); writes null→initial transition on spawn"],
  ],
  examples: [
    'mcx claude spawn --task "run the test suite and fix failures"',
    'mcx claude spawn --allow Bash Read Write --task "monitor prod health"',
    'mcx claude spawn -w fix-auth -t "fix the auth bug in issue #42"',
    'mcx claude spawn --headed --task "interactive debugging session"',
  ],
});

registerHelp("claude ls", {
  name: "mcx claude ls",
  summary: "List active Claude Code sessions",
  usage: ["mcx claude ls", "mcx claude ls --all", "mcx claude ls --pr"],
  options: [
    ["--json", "Output raw JSON"],
    ["--short", "Compact one-line-per-session format"],
    ["--pr", "Show PR status for worktree sessions"],
    ["--all, -a", "Show all sessions (bypass repo scoping)"],
  ],
});

registerHelp("claude send", {
  name: "mcx claude send",
  summary: "Send a follow-up prompt to a running session",
  usage: ["mcx claude send <session> <message>", "mcx claude send --wait <session> <message>"],
  options: [
    ["--wait", "Block until Claude produces a result"],
    ["--if-idle", "Exit non-zero if the session is busy instead of queuing the prompt"],
  ],
  examples: ['mcx claude send abc123 "now run the tests"'],
});

registerHelp("claude bye", {
  name: "mcx claude bye",
  summary: "End a session and stop the process",
  usage: ['mcx claude bye <session> "wrap up"', "mcx claude bye --all", "mcx claude bye <session> --keep-worktree"],
  options: [
    ["--keep, --keep-worktree", "Preserve worktree after session ends"],
    ["--all, -a", "End all sessions in scope"],
  ],
});

registerHelp("claude interrupt", {
  name: "mcx claude interrupt",
  summary: "Interrupt the current turn of a session",
  usage: ["mcx claude interrupt <session>"],
});

registerHelp("claude log", {
  name: "mcx claude log",
  summary: "View session transcript",
  usage: [
    "mcx claude log <session>",
    "mcx claude log <session> --last 50",
    "mcx claude log <session> --json --jq '.[]'",
  ],
  options: [
    ["--last, -n, --tail <N>", "Show last N entries (default: 20)"],
    ["--json", "Output raw JSON"],
    ["--full", "Full output (no truncation)"],
    ["--jq <filter>", "Apply jq filter to JSON output"],
    ["--compact", "Compact output mode"],
  ],
});

registerHelp("claude wait", {
  name: "mcx claude wait",
  summary: "Block until a session event occurs",
  usage: ["mcx claude wait <session>", "mcx claude wait --all", "mcx claude wait --pr 42", "mcx claude wait --checks"],
  options: [
    ["--timeout, -t <ms>", `Max wait time in ms (default: ${DEFAULT_TIMEOUT_MS}, max: ${MAX_TIMEOUT_MS})`],
    ["--after <seq>", "Sequence cursor for race-free polling"],
    ["--short", "Compact output"],
    ["--all, -a", "Wait across all sessions (bypass repo scoping)"],
    ["--any", "Race session + work item events (return whichever fires first)"],
    ["--pr <number>", "Block until a specific PR changes state"],
    ["--checks", "Block until any tracked PR's CI completes"],
    ["--mail-to <recipient>", "Also wake on mail addressed to recipient"],
  ],
});

registerHelp("claude resume", {
  name: "mcx claude resume",
  summary: "Resume a session in a worktree",
  usage: [
    "mcx claude resume <worktree>",
    "mcx claude resume <worktree> <session>",
    "mcx claude resume <worktree> --fresh",
    "mcx claude resume --all",
  ],
  options: [
    ["--fresh", "Use git-context prompt instead of conversation history"],
    ["--all", "Resume all orphaned worktrees (batch mode)"],
    ["--model, -m <name>", "Model: opus, sonnet, haiku, or full ID"],
    ["--allow <tools...>", "Space-separated tool patterns to auto-approve"],
    ["--wait", "Block until Claude produces a result"],
    ["--timeout <ms>", `Max wait time in ms (default: ${DEFAULT_TIMEOUT_MS})`],
  ],
});

registerHelp("claude worktrees", {
  name: "mcx claude worktrees",
  summary: "List or prune mcx-created worktrees",
  usage: ["mcx claude worktrees", "mcx claude worktrees --prune"],
  options: [["--prune", "Remove orphaned worktrees and merged branches"]],
});

registerHelp("claude approve", {
  name: "mcx claude approve",
  summary: "Approve the latest pending permission request",
  usage: ["mcx claude approve <session>", "mcx claude approve <session> --request-id <id>"],
  options: [["--request-id, -r <id>", "Specific request ID (auto-detects latest if omitted)"]],
});

registerHelp("claude deny", {
  name: "mcx claude deny",
  summary: "Deny the latest pending permission request",
  usage: ["mcx claude deny <session>", 'mcx claude deny <session> --message "not allowed"'],
  options: [
    ["--request-id, -r <id>", "Specific request ID (auto-detects latest if omitted)"],
    ["--message, -m <reason>", "Denial reason"],
  ],
});

registerHelp("claude patch-update", {
  name: "mcx claude patch-update",
  summary: "Refresh the patched copy of claude used for mcx-spawned sessions (see #1808)",
  usage: [
    "mcx claude patch-update",
    "mcx claude patch-update --force",
    "mcx claude patch-update --source /path/to/claude",
    "mcx claude patch-update --json",
  ],
  options: [
    ["--force", "Re-patch even if the cached copy looks current"],
    ["--source <path>", "Use this binary as the source (default: `which claude`)"],
    ["--json", "Output the outcome as structured JSON"],
  ],
  examples: [
    "mcx claude patch-update                    # idempotent; runs after every claude auto-update",
    "mcx claude patch-update --force            # rebuild the patched copy from scratch",
  ],
});
