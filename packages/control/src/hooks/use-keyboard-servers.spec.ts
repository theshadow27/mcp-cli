import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import { initialAddServerState } from "../components/server-add-form";
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
    addServerMode: false,
    setAddServerMode: mock(() => {}),
    addServerState: initialAddServerState(),
    setAddServerState: mock(() => {}),
    confirmRemove: false,
    setConfirmRemove: mock(() => {}),
    configInfo: {},
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

  test("j clamps to 0 when servers list is empty", () => {
    let result = -1;
    const nav = makeNav({
      servers: [] as ServersNav["servers"],
      selectedIndex: 0,
      setSelectedIndex: mock((fn: (i: number) => number) => {
        result = fn(0);
      }),
    });
    handleServersInput("j", baseKey, nav);
    expect(result).toBe(0); // must not go to -1
  });

  test("j advances index by 1 from middle of list", () => {
    let result = -1;
    const nav = makeNav({
      setSelectedIndex: mock((fn: (i: number) => number) => {
        result = fn(0);
      }),
    });
    handleServersInput("j", baseKey, nav);
    expect(result).toBe(1);
  });

  test("k decrements index by 1", () => {
    let result = -1;
    const nav = makeNav({
      selectedIndex: 1,
      setSelectedIndex: mock((fn: (i: number) => number) => {
        result = fn(1);
      }),
    });
    handleServersInput("k", baseKey, nav);
    expect(result).toBe(0);
  });

  test("Enter expands correct server name", () => {
    const nav = makeNav({ selectedIndex: 1 });
    handleServersInput("", { ...baseKey, return: true }, nav);
    expect(nav.setExpandedServer).toHaveBeenCalledWith("s2");
  });

  test("Enter collapses when already expanded", () => {
    const nav = makeNav({ selectedIndex: 0, expandedServer: "s1" });
    handleServersInput("", { ...baseKey, return: true }, nav);
    expect(nav.setExpandedServer).toHaveBeenCalledWith(null);
  });

  test("a sets auth status with correct server name", () => {
    const nav = makeNav({ selectedIndex: 1 });
    handleServersInput("a", baseKey, nav);
    expect(nav.setAuthStatus).toHaveBeenCalledWith({ server: "s2", state: "pending" });
  });
});
