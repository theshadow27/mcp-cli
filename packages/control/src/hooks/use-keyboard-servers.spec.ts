import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import type { ServersNav } from "./use-keyboard";
import { handleServersInput } from "./use-keyboard-servers";

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

function makeNav(overrides: Partial<ServersNav> = {}): ServersNav {
  return {
    servers: [
      { name: "s1", state: "connected", transport: "stdio", toolCount: 0, source: "test" },
      { name: "s2", state: "connected", transport: "stdio", toolCount: 0, source: "test" },
    ] as ServersNav["servers"],
    selectedIndex: 0,
    setSelectedIndex: mock(() => {}),
    expandedServer: null,
    setExpandedServer: mock(() => {}),
    refresh: mock(() => {}),
    authStatus: null,
    setAuthStatus: mock(() => {}),
    ...overrides,
  };
}

describe("handleServersInput", () => {
  test("j moves selection down", () => {
    const nav = makeNav();
    const consumed = handleServersInput("j", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setSelectedIndex).toHaveBeenCalled();
  });

  test("k moves selection up", () => {
    const nav = makeNav({ selectedIndex: 1 });
    const consumed = handleServersInput("k", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setSelectedIndex).toHaveBeenCalled();
  });

  test("downArrow moves selection down", () => {
    const nav = makeNav();
    const consumed = handleServersInput("", { ...baseKey, downArrow: true }, nav);
    expect(consumed).toBe(true);
    expect(nav.setSelectedIndex).toHaveBeenCalled();
  });

  test("Enter toggles expanded server", () => {
    const nav = makeNav();
    const consumed = handleServersInput("", { ...baseKey, return: true }, nav);
    expect(consumed).toBe(true);
    expect(nav.setExpandedServer).toHaveBeenCalled();
  });

  test("r restarts selected server", () => {
    const nav = makeNav();
    const consumed = handleServersInput("r", baseKey, nav);
    expect(consumed).toBe(true);
  });

  test("R restarts all servers", () => {
    const nav = makeNav();
    const consumed = handleServersInput("R", baseKey, nav);
    expect(consumed).toBe(true);
  });

  test("a triggers auth", () => {
    const nav = makeNav();
    const consumed = handleServersInput("a", baseKey, nav);
    expect(consumed).toBe(true);
    expect(nav.setAuthStatus).toHaveBeenCalled();
  });

  test("a is no-op when auth is pending", () => {
    const nav = makeNav({ authStatus: { server: "s1", state: "pending" } });
    const consumed = handleServersInput("a", baseKey, nav);
    expect(consumed).toBe(true);
    // setAuthStatus should NOT be called again
    expect(nav.setAuthStatus).not.toHaveBeenCalled();
  });

  test("unrecognized key returns false", () => {
    const nav = makeNav();
    const consumed = handleServersInput("z", baseKey, nav);
    expect(consumed).toBe(false);
  });

  test("setSelectedIndex clamps to bounds", () => {
    let result = 0;
    const nav = makeNav({
      selectedIndex: 0,
      setSelectedIndex: mock((fn: (i: number) => number) => {
        result = fn(0);
      }),
    });

    handleServersInput("k", baseKey, nav);
    expect(result).toBe(0); // can't go below 0

    (nav.setSelectedIndex as ReturnType<typeof mock>).mockImplementation((fn: (i: number) => number) => {
      result = fn(1);
    });
    handleServersInput("j", baseKey, nav);
    expect(result).toBe(1); // already at max (2 servers, index 1)
  });
});
