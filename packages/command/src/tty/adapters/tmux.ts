/**
 * tmux terminal adapter.
 * Uses tmux CLI to create windows (tabs) and sessions (windows).
 */

import type { TerminalAdapter, TtyMode } from "../adapter";
import { type SpawnFn, defaultSpawn } from "../spawn";

export class TmuxAdapter implements TerminalAdapter {
  readonly name = "tmux";
  private spawn: SpawnFn;

  constructor(spawn: SpawnFn = defaultSpawn) {
    this.spawn = spawn;
  }

  async open(command: string, mode: TtyMode): Promise<void> {
    const args = mode === "window" ? ["tmux", "new-session", "-d", command] : ["tmux", "new-window", command];

    await this.spawn(args, "tmux");
  }
}
