/**
 * iTerm2 terminal adapter.
 * Uses AppleScript to create tabs/windows via iTerm2's scripting interface.
 */

import type { TerminalAdapter, TtyMode } from "../adapter";
import { type SpawnFn, defaultSpawn } from "../spawn";

export class ItermAdapter implements TerminalAdapter {
  readonly name = "iTerm2";
  private spawn: SpawnFn;

  constructor(spawn: SpawnFn = defaultSpawn) {
    this.spawn = spawn;
  }

  async open(command: string, mode: TtyMode): Promise<void> {
    const escaped = command.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

    const script =
      mode === "window"
        ? `tell application "iTerm2"
  activate
  set newWindow to (create window with default profile)
  tell current session of newWindow
    write text "${escaped}"
  end tell
end tell`
        : `tell application "iTerm2"
  activate
  tell current window
    set newTab to (create tab with default profile)
    tell current session of newTab
      write text "${escaped}"
    end tell
  end tell
end tell`;

    await this.spawn(["osascript", "-e", script], "iTerm2");
  }
}
