/**
 * Terminal.app adapter.
 * Uses AppleScript to open tabs/windows in macOS's built-in Terminal.
 */

import type { TerminalAdapter, TtyMode } from "../adapter";
import { type SpawnFn, defaultSpawn } from "../spawn";

export class TerminalAppAdapter implements TerminalAdapter {
  readonly name = "Terminal.app";
  private spawn: SpawnFn;

  constructor(spawn: SpawnFn = defaultSpawn) {
    this.spawn = spawn;
  }

  async open(command: string, mode: TtyMode): Promise<void> {
    const escaped = command.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

    const script =
      mode === "window"
        ? `tell application "Terminal"
  activate
  do script "${escaped}"
end tell`
        : `tell application "Terminal"
  activate
  tell application "System Events" to tell process "Terminal" to click menu item "New Tab" of menu "File" of menu bar 1
  do script "${escaped}" in front window
end tell`;

    await this.spawn(["osascript", "-e", script], "Terminal.app");
  }
}
