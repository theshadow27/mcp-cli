/**
 * ACP agent registry — known ACP-compatible agents and their spawn commands.
 */

export interface AcpAgent {
  /** Display name (e.g. "copilot", "gemini"). */
  name: string;
  /** Standalone binary name to try first. */
  command: string;
  /** Args appended after the command (e.g. ["--acp"]). */
  args: string[];
  /** Human-readable install instructions shown when the agent is not found. */
  installHint: string;
}

/**
 * Known ACP agents. The command field is the standalone binary name;
 * resolution logic in acp-resolve.ts handles falling back to `gh <command>`.
 */
export const ACP_AGENTS: Record<string, AcpAgent> = {
  copilot: {
    name: "copilot",
    command: "copilot",
    args: ["--acp"],
    installHint: "Install with: gh extension install github/gh-copilot",
  },
  gemini: {
    name: "gemini",
    command: "gemini",
    args: ["--acp"],
    installHint: "Install with: npm install -g @anthropic-ai/gemini-cli",
  },
};
