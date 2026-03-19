/**
 * `mcx copilot` — thin wrapper around `mcx acp` with `--agent copilot` pre-set.
 *
 * Users shouldn't need to know what ACP is:
 *   mcx copilot spawn --task "description"
 *   mcx copilot ls
 *   mcx copilot send <session> <message>
 */

import { cmdAcp } from "./acp";

export async function cmdCopilot(args: string[]): Promise<void> {
  return cmdAcp(args, "copilot");
}
