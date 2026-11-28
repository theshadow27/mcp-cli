import type { Key } from "ink";
import type { StatsNav } from "./use-keyboard";

/**
 * Handle keyboard input for the stats view.
 * Returns true if the input was consumed.
 */
export function handleStatsInput(input: string, key: Key, nav: StatsNav): boolean {
  if (key.upArrow || input === "k") {
    nav.setScrollOffset((o) => Math.max(0, o - 1));
    return true;
  }
  if (key.downArrow || input === "j") {
    nav.setScrollOffset((o) => Math.min(Math.max(0, nav.lineCount - 1), o + 1));
    return true;
  }
  return false;
}
