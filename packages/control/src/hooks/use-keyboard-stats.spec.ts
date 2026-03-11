import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import type { StatsNav } from "./use-keyboard";
import { handleStatsInput } from "./use-keyboard-stats";

const baseKey: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

function makeNav(overrides: Partial<StatsNav> = {}): StatsNav {
  return {
    scrollOffset: 0,
    setScrollOffset: mock(() => {}),
    lineCount: 50,
    ...overrides,
  };
}

describe("handleStatsInput", () => {
  test("j scrolls down", () => {
    let result = 0;
    const nav = makeNav({
      setScrollOffset: mock((fn: (o: number) => number) => {
        result = fn(0);
      }),
    });
    const consumed = handleStatsInput("j", baseKey, nav);
    expect(consumed).toBe(true);
    expect(result).toBe(1);
  });

  test("k scrolls up", () => {
    let result = 0;
    const nav = makeNav({
      scrollOffset: 5,
      setScrollOffset: mock((fn: (o: number) => number) => {
        result = fn(5);
      }),
    });
    const consumed = handleStatsInput("k", baseKey, nav);
    expect(consumed).toBe(true);
    expect(result).toBe(4);
  });

  test("downArrow scrolls down", () => {
    const nav = makeNav();
    const consumed = handleStatsInput("", { ...baseKey, downArrow: true }, nav);
    expect(consumed).toBe(true);
    expect(nav.setScrollOffset).toHaveBeenCalled();
  });

  test("upArrow scrolls up", () => {
    const nav = makeNav();
    const consumed = handleStatsInput("", { ...baseKey, upArrow: true }, nav);
    expect(consumed).toBe(true);
    expect(nav.setScrollOffset).toHaveBeenCalled();
  });

  test("k clamps at 0", () => {
    let result = -1;
    const nav = makeNav({
      scrollOffset: 0,
      setScrollOffset: mock((fn: (o: number) => number) => {
        result = fn(0);
      }),
    });
    handleStatsInput("k", baseKey, nav);
    expect(result).toBe(0);
  });

  test("j clamps at lineCount - 1", () => {
    let result = -1;
    const nav = makeNav({
      lineCount: 10,
      setScrollOffset: mock((fn: (o: number) => number) => {
        result = fn(9);
      }),
    });
    handleStatsInput("j", baseKey, nav);
    expect(result).toBe(9);
  });

  test("j clamps to 0 when lineCount is 0", () => {
    let result = -1;
    const nav = makeNav({
      lineCount: 0,
      setScrollOffset: mock((fn: (o: number) => number) => {
        result = fn(0);
      }),
    });
    handleStatsInput("j", baseKey, nav);
    expect(result).toBe(0);
  });

  test("unrecognized key returns false", () => {
    const nav = makeNav();
    expect(handleStatsInput("z", baseKey, nav)).toBe(false);
  });
});
