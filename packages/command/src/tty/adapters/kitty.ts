/**
 * Kitty terminal adapter.
 * Uses the `kitten` CLI to launch tabs and OS windows.
 */

import type { TerminalAdapter, TtyMode } from "../adapter";
import { type SpawnFn, defaultSpawn } from "../spawn";

export class KittyAdapter implements TerminalAdapter {
  readonly name = "Kitty";
  private spawn: SpawnFn;

  constructor(spawn: SpawnFn = defaultSpawn) {
    this.spawn = spawn;
  }

  async open(command: string, mode: TtyMode): Promise<void> {
    const launchType = mode === "window" ? "os-window" : "tab";
    const args = ["kitten", "@", "launch", `--type=${launchType}`, "--copy-env", "sh", "-c", command];

    await this.spawn(args, "Kitty");
  }
}
