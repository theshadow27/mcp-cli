/**
 * TerminalAdapter — common interface for launching commands in terminal emulators.
 *
 * Each adapter implements tab and window creation for a specific terminal.
 * Register new adapters by adding an entry to `ADAPTERS`.
 */

import { GhosttyAdapter } from "./adapters/ghostty";
import { ItermAdapter } from "./adapters/iterm";
import { KittyAdapter } from "./adapters/kitty";
import { TerminalAppAdapter } from "./adapters/terminal-app";
import { TmuxAdapter } from "./adapters/tmux";
import { WeztermAdapter } from "./adapters/wezterm";

export type TtyMode = "tab" | "window";

export interface TerminalAdapter {
  /** Display name of the terminal (e.g. "Ghostty") */
  readonly name: string;
  /** Open a command in a new tab or window */
  open(command: string, mode: TtyMode): Promise<void>;
}

/** Registry of known terminal adapters, keyed by CLI name */
export const ADAPTERS: Record<string, () => TerminalAdapter> = {
  ghostty: () => new GhosttyAdapter(),
  iterm: () => new ItermAdapter(),
  terminal: () => new TerminalAppAdapter(),
  tmux: () => new TmuxAdapter(),
  kitty: () => new KittyAdapter(),
  wezterm: () => new WeztermAdapter(),
};

/** All valid terminal names for error messages / help text */
export const TERMINAL_NAMES = Object.keys(ADAPTERS);

/** Resolve a terminal adapter by name. Throws on unknown name. */
export function getAdapter(name: string): TerminalAdapter {
  const factory = ADAPTERS[name];
  if (!factory) {
    throw new Error(`Unknown terminal "${name}". Valid terminals: ${TERMINAL_NAMES.join(", ")}`);
  }
  return factory();
}
