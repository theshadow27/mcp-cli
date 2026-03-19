/**
 * Resolve an ACP agent's spawn command.
 *
 * Strategy:
 *   1. Try the standalone binary (e.g. `copilot`)
 *   2. Fall back to `gh <command>` (e.g. `gh copilot`)
 *   3. Throw with install instructions if neither is found
 *
 * Resolution happens once at spawn time — callers cache the result.
 */

import type { AcpAgent } from "./agents";

/** Signature matching Bun.which — injectable for testing. */
export type WhichFn = (bin: string) => string | null;

/**
 * Resolve the full spawn command array for an ACP agent.
 *
 * @param agent  Agent definition from the registry
 * @param which  Binary lookup function (defaults to Bun.which)
 * @returns      Command array suitable for Bun.spawn (e.g. ["gh", "copilot", "--acp"])
 */
export function resolveAcpCommand(agent: AcpAgent, which: WhichFn = Bun.which): string[] {
  // 1. Try standalone binary
  if (which(agent.command)) {
    return [agent.command, ...agent.args];
  }

  // 2. Fall back to gh extension
  if (which("gh")) {
    return ["gh", agent.command, ...agent.args];
  }

  // 3. Neither found
  throw new Error(`ACP agent \`${agent.command}\` not found in PATH. ${agent.installHint}`);
}
