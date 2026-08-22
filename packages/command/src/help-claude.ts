import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "@mcp-cli/core";
import { registerHelp } from "./help";

registerHelp("claude spawn", {
  name: "mcx claude spawn",
  summary: "Start a new Claude Code session (returns immediately)",
  notes: [
    "NOTE: spawn returns immediately with the new session ID. The session runs",
    "asynchronously in the daemon. Do not invoke this command via a background",
    "runner — it is wasteful and clutters the audit trail. To block on",
    "completion, use: mcx claude wait <session-id>",
  ],
  usage: [
    'mcx claude spawn --task "description"',
    'mcx claude spawn --task "description" --allow Bash Read Write',
    'mcx claude spawn --task "description" --worktree my-feature',
    'mcx claude spawn --headed --task "description"',
    'mcx claude spawn --task "description" --claude-binary /path/to/claude --transport stdio',
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
    [
      "--claude-binary <path>",
      "Per-spawn binary override for this session only (bypasses global claude-binary config; resolved at dispatch)",
    ],
    [
      "--transport <stdio|sdk-url>",
      "Per-spawn transport override for this session only (bypasses global transport config)",
    ],
    [
      "--profile <name>",
      "Apply the env bundle in ~/.mcp-cli/profiles/<name>.env to this session (e.g. Bedrock credentials). See: mcx claude profile ls",
    ],
    ["--no-profile", "Run on the bare daemon env, ignoring a repo .mcx.yaml profile or the default-profile config"],
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
  summary: "End a session and stop the process (worktree is kept by default)",
  usage: ['mcx claude bye <session> "wrap up"', "mcx claude bye --all", "mcx claude bye <session> --clean"],
  options: [
    ["--clean", "Also remove the worktree and delete its branch"],
    ["--keep, --keep-worktree", "No-op: keeping the worktree is the default"],
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

registerHelp("claude status", {
  name: "mcx claude status",
  summary: "One-shot session inspector — show transcript metrics for one or more sessions",
  usage: ["mcx claude status <target>", "mcx claude status <target1>,<target2>", "mcx claude status <target> --json"],
  options: [["--json", "Output raw JSON instead of formatted display"]],
  examples: ["mcx claude status Alice", "mcx claude status Alice,Bob", "mcx claude status abc123 --json"],
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

registerHelp("claude auth", {
  name: "mcx claude auth",
  summary: "Save, list, and switch Claude identities without an interactive /login (see #3006)",
  notes: [
    "Linux only for now — on macOS Claude Code keeps its credentials in the Keychain,",
    "so save/load exit 2 with a clear error there (ls still works).",
    "",
    "Honors CLAUDE_CONFIG_DIR (and CLAUDE_SECURESTORAGE_CONFIG_DIR): with a redirected",
    "config dir the credentials, .claude.json and policy-limits.json all live inside it.",
    "",
    "A profile snapshots ~/.claude/.credentials.json plus the userID/oauthAccount keys",
    "in ~/.claude.json. Profiles live in ~/.mcp-cli/auth-profiles/ (dir 0700, files 0600).",
    "API key VALUES are never stored: an api-key profile records only the env var name.",
    "`load` preserves the credentials it is about to replace before replacing them:",
    "written back to the profile that provably owns them (fingerprint or same account),",
    "or copied into ~/.mcp-cli/auth-profiles/backups/ when ownership cannot be proven —",
    "so a token Claude refreshed in place is never lost. It also drops the cached",
    "policy-limits.json so org policy does not leak across identities.",
  ],
  usage: [
    "mcx claude auth save <profile> [--json]",
    "mcx claude auth save <profile> --api-key-env ANTHROPIC_API_KEY",
    "mcx claude auth save <profile> --oauth",
    "mcx claude auth load <profile> [--json]",
    "mcx claude auth ls [--json]",
  ],
  options: [
    ["--json", "Structured JSON on stdout instead of human text"],
    ["--api-key-env <VAR>", "Save an api-key profile bound to this env var name (value never stored)"],
    ["--oauth", "Capture the claude.ai OAuth identity even when ANTHROPIC_API_KEY is exported"],
  ],
  examples: [
    "mcx claude auth save work           # capture the identity that is logged in right now",
    "mcx claude auth load personal       # switch to another saved identity",
    "mcx claude auth ls --json | jq '.[] | {name, expiresAt}'",
  ],
});

registerHelp("claude profile", {
  name: "mcx claude profile",
  summary: "Manage spawn profiles — named env-var bundles applied to spawned sessions (see #935)",
  notes: [
    "A profile is one dotenv-shaped file: ~/.mcp-cli/profiles/<name>.env (dir 0700, files 0600).",
    "`KEY=VALUE`, `#` comments, an optional `export ` prefix so a shell file you already",
    "source imports verbatim. Its motivating use is routing spawned workers at AWS Bedrock",
    "(CLAUDE_CODE_USE_BEDROCK, AWS_BEARER_TOKEN_BEDROCK, ANTHROPIC_DEFAULT_*_MODEL) while",
    "the interactive session stays on the subscription.",
    "",
    "Which profile a spawn uses, highest precedence first:",
    "  --profile <name>  >  `profile:` in the repo .mcx.yaml  >  default-profile config  >  none",
    "`--no-profile` opts out at the top of that chain. `mcx config set default-profile <name>`",
    "sets the bottom one, so internal call sites (phase scripts, `mcx memory`) cannot fall",
    "back to the bare daemon env by forgetting a flag.",
    "",
    "Values never leave the daemon: only the profile NAME travels over IPC, and `show`",
    "prints variable names only. There is deliberately no `set KEY=VALUE` subcommand —",
    "a secret in argv lands in shell history and in every `ps` on the box.",
    "GIT_DIR, GIT_WORK_TREE, PWD, TRACEPARENT and CLAUDECODE are rejected: the daemon",
    "derives those per-spawn and a profile overriding them would escape containment.",
  ],
  usage: [
    "mcx claude profile ls [--json]",
    "mcx claude profile show <name> [--json]",
    "mcx claude profile import <name> <file>",
  ],
  options: [["--json", "Structured JSON on stdout instead of human text"]],
  examples: [
    "mcx claude profile import bedrock ~/github/claude_bedrock.sh",
    "mcx claude profile show bedrock            # variable NAMES only, never values",
    'mcx claude spawn --profile bedrock -t "run the suite"',
    "mcx config set default-profile bedrock     # every spawn, including internal ones",
    'mcx claude spawn --no-profile -t "one session on the subscription"',
  ],
});
