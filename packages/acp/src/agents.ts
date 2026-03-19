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

/**
 * Resolve an agent name or custom command to spawn arguments.
 *
 * If `customCommand` is provided, uses that instead.
 * Falls back to `[agent, "--acp"]` for unknown agent names.
 * Note: does not check PATH — use resolveAcpCommand() for that.
 */
export function resolveAgentCommand(
  agent: string,
  customCommand?: string[],
): { command: string[]; displayName: string } {
  if (customCommand && customCommand.length > 0) {
    return { command: customCommand, displayName: `custom (${customCommand[0]})` };
  }

  const known = ACP_AGENTS[agent];
  if (known) {
    return { command: [known.command, ...known.args], displayName: known.name };
  }

  // Unknown agent — assume it supports --acp
  return { command: [agent, "--acp"], displayName: agent };
}
