import { describe, expect, test } from "bun:test";
import type { Key } from "ink";
import type { PlansNav } from "./use-keyboard";
import { handlePlansInput } from "./use-keyboard-plans";

function makeKey(overrides: Partial<Key> = {}): Key {
  return {
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
    ...overrides,
  };
}

function makeNav(overrides: Partial<PlansNav> = {}): PlansNav & { index: number } {
  const nav = {
    selectedIndex: 0,
    index: 0,
    planCount: 5,
    setSelectedIndex: (fn: (i: number) => number) => {
      nav.index = fn(nav.index);
    },
    ...overrides,
  };
  return nav;
}

describe("handlePlansInput", () => {
  test("j moves selection down", () => {
    const nav = makeNav();
    const consumed = handlePlansInput("j", makeKey(), nav);
    expect(consumed).toBe(true);
    expect(nav.index).toBe(1);
  });

  test("k moves selection up", () => {
    const nav = makeNav();
    nav.index = 3;
    const consumed = handlePlansInput("k", makeKey(), nav);
    expect(consumed).toBe(true);
    expect(nav.index).toBe(2);
  });

  test("downArrow moves selection down", () => {
    const nav = makeNav();
    const consumed = handlePlansInput("", makeKey({ downArrow: true }), nav);
    expect(consumed).toBe(true);
    expect(nav.index).toBe(1);
  });

  test("upArrow moves selection up", () => {
    const nav = makeNav();
    nav.index = 2;
    const consumed = handlePlansInput("", makeKey({ upArrow: true }), nav);
    expect(consumed).toBe(true);
    expect(nav.index).toBe(1);
  });

  test("clamps at bottom", () => {
    const nav = makeNav({ planCount: 3 });
    nav.index = 2;
    handlePlansInput("j", makeKey(), nav);
    expect(nav.index).toBe(2);
  });

  test("clamps at top", () => {
    const nav = makeNav();
    nav.index = 0;
    handlePlansInput("k", makeKey(), nav);
    expect(nav.index).toBe(0);
  });

  test("returns false for unrecognized input", () => {
    const nav = makeNav();
    const consumed = handlePlansInput("x", makeKey(), nav);
    expect(consumed).toBe(false);
  });
});
