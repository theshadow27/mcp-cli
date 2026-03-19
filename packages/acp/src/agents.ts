/**
 * ACP agent registry.
 *
 * Maps well-known ACP-compatible agent names to their spawn commands.
 * Users can also pass a custom command for unlisted ACP agents.
 */

export interface AcpAgent {
  /** Short name used in tool params and CLI. */
  name: string;
  /** Binary to spawn. */
  command: string;
  /** Arguments to pass (typically ["--acp"]). */
  args: string[];
  /** Human-readable display name. */
  displayName: string;
}

export const AGENTS: Record<string, AcpAgent> = {
  copilot: {
    name: "copilot",
    command: "gh",
    args: ["copilot", "--acp"],
    displayName: "GitHub Copilot",
  },
  gemini: {
    name: "gemini",
    command: "gemini",
    args: ["--acp"],
    displayName: "Google Gemini",
  },
};

/**
 * Resolve an agent name or custom command to spawn arguments.
 *
 * If `agent` matches a known registry entry, returns its command + args.
 * If `customCommand` is provided, uses that instead.
 * Falls back to `[agent, "--acp"]` for unknown agent names.
 */
export function resolveAgentCommand(
  agent: string,
  customCommand?: string[],
): { command: string[]; displayName: string } {
  if (customCommand && customCommand.length > 0) {
    return { command: customCommand, displayName: `custom (${customCommand[0]})` };
  }

  const known = AGENTS[agent];
  if (known) {
    return { command: [known.command, ...known.args], displayName: known.displayName };
  }

  // Unknown agent — assume it supports --acp
  return { command: [agent, "--acp"], displayName: agent };
}
