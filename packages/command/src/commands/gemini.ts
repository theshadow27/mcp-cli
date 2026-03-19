/**
 * `mcx gemini` — thin wrapper around `mcx acp` with `--agent gemini` pre-set.
 *
 * Users shouldn't need to know what ACP is:
 *   mcx gemini spawn --task "description"
 *   mcx gemini ls
 *   mcx gemini send <session> <message>
 */

import { cmdAcp } from "./acp";

export async function cmdGemini(args: string[]): Promise<void> {
  return cmdAcp(args, "gemini");
}
