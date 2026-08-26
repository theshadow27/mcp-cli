import { describe, expect, test } from "bun:test";
import { NO_REPO_ROOT } from "@mcp-cli/core";
import { STATE_ROOT_RETRY_MS, createAutomationStateRoot } from "./automation-state-root";

function makeLogger() {
  const warns: string[] = [];
  return {
    logger: {
      info: () => {},
      warn: (m: string) => warns.push(m),
      error: () => {},
      debug: () => {},
    } as never,
    warns,
  };
}

describe("createAutomationStateRoot (#3209 review / #3378)", () => {
  test("does not resolve until first call — the daemon boots without a git probe", () => {
    // The whole point of finding 1: this block runs before ipcServer.start(), and
    // workItemStateRoot spawns up to three 5s git probes. Constructing must be free.
    let probes = 0;
    const { logger } = makeLogger();
    const get = createAutomationStateRoot({
      cwd: () => "/repo",
      logger,
      resolveRoot: () => {
        probes++;
        return "/repo";
      },
    });
    expect(probes).toBe(0);
    expect(get()).toBe("/repo");
    expect(probes).toBe(1);
  });

  test("memoizes a real root — an event storm costs one probe", () => {
    let probes = 0;
    const { logger } = makeLogger();
    const get = createAutomationStateRoot({
      cwd: () => "/repo",
      logger,
      resolveRoot: () => {
        probes++;
        return "/repo";
      },
    });
    for (let i = 0; i < 50; i++) expect(get()).toBe("/repo");
    expect(probes).toBe(1);
  });

  test("does NOT memoize the sentinel — a recovered host is picked up", () => {
    // The #3378 regression: one bad probe at boot froze every getWorkItemState read into
    // the NO_REPO_ROOT bucket until the daemon was restarted.
    let clock = 0;
    let root = NO_REPO_ROOT;
    const { logger, warns } = makeLogger();
    const get = createAutomationStateRoot({
      cwd: () => "/repo",
      logger,
      resolveRoot: () => root,
      now: () => clock,
      retryMs: STATE_ROOT_RETRY_MS,
    });

    expect(get()).toBe(NO_REPO_ROOT);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("could not be resolved");

    root = "/repo";
    clock += STATE_ROOT_RETRY_MS;
    expect(get()).toBe("/repo");
    // And it sticks from there.
    root = NO_REPO_ROOT;
    expect(get()).toBe("/repo");
  });

  test("throttles retries — calls inside the window do not re-probe or re-warn", () => {
    let clock = 0;
    let probes = 0;
    const { logger, warns } = makeLogger();
    const get = createAutomationStateRoot({
      cwd: () => "/repo",
      logger,
      resolveRoot: () => {
        probes++;
        return NO_REPO_ROOT;
      },
      now: () => clock,
      retryMs: STATE_ROOT_RETRY_MS,
    });

    for (let i = 0; i < 100; i++) {
      clock += 100; // still well inside the retry window
      expect(get()).toBe(NO_REPO_ROOT);
    }
    expect(probes).toBe(1);
    expect(warns).toHaveLength(1);

    clock += STATE_ROOT_RETRY_MS;
    expect(get()).toBe(NO_REPO_ROOT);
    expect(probes).toBe(2);
    expect(warns).toHaveLength(2);
  });

  test("reads cwd per probe rather than capturing it at construction", () => {
    // #3192 will change *which* cwd this is; a captured value would make that a rewrite.
    let cwd = "/first";
    const { logger } = makeLogger();
    let clock = 0;
    const get = createAutomationStateRoot({
      cwd: () => cwd,
      logger,
      resolveRoot: (c) => (c === "/second" ? "/second" : NO_REPO_ROOT),
      now: () => clock,
      retryMs: 10,
    });
    expect(get()).toBe(NO_REPO_ROOT);
    cwd = "/second";
    clock += 10;
    expect(get()).toBe("/second");
  });
});
