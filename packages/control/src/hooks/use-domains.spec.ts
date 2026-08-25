import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Domain } from "@mcp-cli/core";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React, { type FC } from "react";
import { type UseDomainsOptions, type UseDomainsResult, detect, useDomains } from "./use-domains";

function domain(id: number, name: string, path: string, host: string | null = null): Domain {
  return { id, name, host, path, createdAt: "2026-08-24T00:00:00.000Z" };
}

const DOMAINS: Domain[] = [domain(1, "phoenix", "/srv/phoenix"), domain(2, "mcp-cli", "/srv/mcp-cli")];

/** Wait for a condition rather than for a fixed number of milliseconds. */
async function waitFor(condition: () => boolean, timeoutMs = 1500, intervalMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error("condition not met before deadline");
}

const Harness: FC<{ opts: UseDomainsOptions; stateRef: { current: UseDomainsResult } }> = ({ opts, stateRef }) => {
  stateRef.current = useDomains(opts);
  return React.createElement(Text, null, "ok");
};

describe("useDomains", () => {
  const instances: ReturnType<typeof render>[] = [];

  afterEach(() => {
    for (const inst of instances) inst.unmount();
    instances.length = 0;
  });

  function mount(opts: UseDomainsOptions) {
    const stateRef = { current: {} as UseDomainsResult };
    instances.push(render(React.createElement(Harness, { opts, stateRef })));
    return stateRef;
  }

  /** An `ipcCall` stand-in that answers `domainList` from a mutable array. */
  function listing(source: () => Domain[]): UseDomainsOptions["ipcCallFn"] {
    return (async () => source()) as UseDomainsOptions["ipcCallFn"];
  }

  test("loads the domain list over IPC", async () => {
    const stateRef = mount({ ipcCallFn: listing(() => DOMAINS), cwd: () => "/elsewhere" });
    await waitFor(() => stateRef.current.domains.length === 2);
    expect(stateRef.current.domains.map((d) => d.name)).toEqual(["phoenix", "mcp-cli"]);
  });

  test("auto-selects the domain containing cwd on first load", async () => {
    const stateRef = mount({ ipcCallFn: listing(() => DOMAINS), cwd: () => "/srv/phoenix/packages/core" });
    await waitFor(() => stateRef.current.selectedDomain !== null);
    expect(stateRef.current.selectedDomain?.name).toBe("phoenix");
  });

  test("cwd outside every domain starts on all", async () => {
    const stateRef = mount({ ipcCallFn: listing(() => DOMAINS), cwd: () => "/somewhere/else" });
    await waitFor(() => stateRef.current.domains.length === 2);
    expect(stateRef.current.selectedDomain).toBeNull();
  });

  test("a daemon that is down or too old leaves the filter empty instead of throwing", async () => {
    const failing = (async () => {
      throw new Error("Unknown method: domainList");
    }) as UseDomainsOptions["ipcCallFn"];
    const stateRef = mount({ ipcCallFn: failing, cwd: () => "/srv/phoenix" });
    // Nothing to wait for but the first poll; assert the hook survived it and stayed empty.
    await waitFor(() => typeof stateRef.current.cycleDomain === "function");
    expect(stateRef.current.domains).toEqual([]);
    expect(stateRef.current.selectedDomain).toBeNull();
  });

  test("cycleDomain walks all → first → second → all", async () => {
    const stateRef = mount({ ipcCallFn: listing(() => DOMAINS), cwd: () => "/elsewhere" });
    await waitFor(() => stateRef.current.domains.length === 2);
    expect(stateRef.current.selectedDomain).toBeNull();

    stateRef.current.cycleDomain();
    await waitFor(() => stateRef.current.selectedDomain?.name === "phoenix");

    stateRef.current.cycleDomain();
    await waitFor(() => stateRef.current.selectedDomain?.name === "mcp-cli");

    stateRef.current.cycleDomain();
    await waitFor(() => stateRef.current.selectedDomain === null);
  });

  test("cycleDomain does nothing when no domains are registered", async () => {
    const stateRef = mount({ ipcCallFn: listing(() => []), cwd: () => "/elsewhere" });
    await waitFor(() => typeof stateRef.current.cycleDomain === "function");
    // A no-op by construction: with an empty list `cycleDomain` returns before calling
    // any setter, so there is no pending state update to wait for.
    stateRef.current.cycleDomain();
    expect(stateRef.current.selectedDomain).toBeNull();
  });

  test("a selection that vanished from the list falls back to all", async () => {
    const stateRef = mount({ ipcCallFn: listing(() => DOMAINS), cwd: () => "/elsewhere" });
    await waitFor(() => stateRef.current.domains.length === 2);

    stateRef.current.setSelectedDomain(domain(99, "removed", "/srv/removed"));
    await waitFor(() => stateRef.current.selectedDomain?.id === 99);

    stateRef.current.cycleDomain();
    await waitFor(() => stateRef.current.selectedDomain === null);
  });

  test("polling picks up a domain registered after mount", async () => {
    const live = [...DOMAINS];
    const stateRef = mount({ ipcCallFn: listing(() => live), cwd: () => "/elsewhere", intervalMs: 10 });
    await waitFor(() => stateRef.current.domains.length === 2);

    live.push(domain(3, "gerald", "/srv/gerald"));
    await waitFor(() => stateRef.current.domains.length === 3);
    expect(stateRef.current.domains.map((d) => d.name)).toContain("gerald");
  });
});

describe("detect", () => {
  // realpath'd: `detect` canonicalizes the cwd it is given, so a symlinked temp root
  // (`/tmp` → `/private/tmp` on macOS) would otherwise never match the fixture's path.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "use-domains-")));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("cwd inside a domain selects it", () => {
    const root = join(dir, "phoenix");
    const sub = join(root, "packages", "core");
    mkdirSync(sub, { recursive: true });
    expect(detect([domain(1, "phoenix", root)], sub)?.name).toBe("phoenix");
  });

  test("the innermost domain wins when domains nest", () => {
    const outer = join(dir, "outer");
    const inner = join(outer, "inner");
    mkdirSync(inner, { recursive: true });
    const found = detect([domain(1, "outer", outer), domain(2, "inner", inner)], inner);
    expect(found?.name).toBe("inner");
  });

  test("cwd outside every domain selects none", () => {
    expect(detect(DOMAINS, join(dir, "unrelated"))).toBeNull();
  });

  test("a host-bound domain never owns a local path", () => {
    const root = join(dir, "remote");
    mkdirSync(root, { recursive: true });
    expect(detect([domain(1, "remote", root, "boxen0010")], root)).toBeNull();
  });

  test("a relative cwd is no domain, not a throw", () => {
    expect(detect(DOMAINS, "packages/core")).toBeNull();
  });

  test("no domains registered selects none", () => {
    expect(detect([], dir)).toBeNull();
  });
});
