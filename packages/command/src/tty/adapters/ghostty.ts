/**
 * Ghostty terminal adapter.
 * Uses AppleScript to open tabs/windows in Ghostty.
 */

import type { TerminalAdapter, TtyMode } from "../adapter";
import { type SpawnFn, defaultSpawn } from "../spawn";

export class GhosttyAdapter implements TerminalAdapter {
  readonly name = "Ghostty";
  private spawn: SpawnFn;

  constructor(spawn: SpawnFn = defaultSpawn) {
    this.spawn = spawn;
  }

  async open(command: string, mode: TtyMode): Promise<void> {
    const escaped = command.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

    const script =
      mode === "window"
        ? `tell application "Ghostty"
  activate
  tell application "System Events" to tell process "Ghostty" to click menu item "New Window" of menu "File" of menu bar 1
  delay 0.3
  tell application "System Events" to keystroke "${escaped}"
  tell application "System Events" to key code 36
end tell`
        : `tell application "Ghostty"
  activate
  tell application "System Events" to tell process "Ghostty" to click menu item "New Tab" of menu "File" of menu bar 1
  delay 0.3
  tell application "System Events" to keystroke "${escaped}"
  tell application "System Events" to key code 36
end tell`;

    await this.spawn(["osascript", "-e", script], "Ghostty");
  }
}
