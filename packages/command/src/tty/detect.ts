/**
 * Auto-detect the user's terminal emulator from environment variables.
 * Returns a terminal name matching the ADAPTERS registry, or undefined.
 */

/** Map $TERM_PROGRAM values to adapter registry keys */
const TERM_PROGRAM_MAP: Record<string, string> = {
  ghostty: "ghostty",
  iTerm: "iterm",
  "iTerm.app": "iterm",
  Apple_Terminal: "terminal",
  kitty: "kitty",
  WezTerm: "wezterm",
};

export function detectTerminal(env: Record<string, string | undefined> = process.env): string | undefined {
  // Check $TMUX first — if set, user is in a tmux session
  if (env.TMUX) return "tmux";

  const termProgram = env.TERM_PROGRAM;
  if (termProgram && termProgram in TERM_PROGRAM_MAP) {
    return TERM_PROGRAM_MAP[termProgram];
  }

  return undefined;
}
