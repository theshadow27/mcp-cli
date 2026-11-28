/**
 * WezTerm terminal adapter.
 * Uses the `wezterm` CLI to spawn panes in tabs or new windows.
 */

import type { TerminalAdapter, TtyMode } from "../adapter";
import { type SpawnFn, defaultSpawn } from "../spawn";

export class WeztermAdapter implements TerminalAdapter {
  readonly name = "WezTerm";
  private spawn: SpawnFn;

  constructor(spawn: SpawnFn = defaultSpawn) {
    this.spawn = spawn;
  }

  async open(command: string, mode: TtyMode): Promise<void> {
    const newWindow = mode === "window" ? "true" : "false";
    const args = ["wezterm", "cli", "spawn", `--new-window=${newWindow}`, "--", "sh", "-c", command];

    await this.spawn(args, "WezTerm");
  }
}
