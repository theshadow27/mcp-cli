import type { Key } from "ink";
import type { PlansNav } from "./use-keyboard";

/**
 * Handle keyboard input for the plans view.
 * Returns true if the input was consumed.
 */
export function handlePlansInput(input: string, key: Key, nav: PlansNav): boolean {
  if (key.upArrow || input === "k") {
    nav.setSelectedIndex((i) => Math.max(0, i - 1));
    return true;
  }
  if (key.downArrow || input === "j") {
    nav.setSelectedIndex((i) => Math.min(nav.planCount - 1, i + 1));
    return true;
  }
  return false;
}
