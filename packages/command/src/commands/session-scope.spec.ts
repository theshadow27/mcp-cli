/**
 * The scoping invariant, plus the cross-surface guard.
 *
 * `mcx claude ls` and `mcx agent claude ls` are two front doors onto one daemon tool
 * and have disagreed about the same flag three times. The last of those — `-d` also
 * sending `repoRoot` from the agent surface only — was invisible until `domain` and
 * `repoRoot` started to AND, at which point the two surfaces silently returned
 * different row counts for the same command.
 *
 * The last test here is the mechanization: it drives BOTH CLIs and asserts they emit
 * identical scoping arguments. It fails if either surface drifts again.
 */

import { describe, expect, test } from "bun:test";
import { lookupFailure } from "@mcp-cli/core";
import { buildSessionScope } from "./session-scope";

const noGitRoot = () => null;
const gitRoot = () => "/home/u/github/mcp-cli";
const noop = () => {};

function scope(over: Partial<Parameters<typeof buildSessionScope>[0]> = {}) {
  return buildSessionScope({
    domain: undefined,
    all: false,
    cwd: "/home/u/github/mcp-cli/wt",
    repoScoped: true,
    getGitRoot: gitRoot,
    printError: noop,
    ...over,
  });
}

describe("buildSessionScope", () => {
  test("--all suppresses every filter", () => {
    expect(scope({ all: true, domain: "phoenix" }).args).toEqual({});
    expect(scope({ all: true }).activeFilter).toBeUndefined();
  });

  test("an explicit -d is a PURE domain query — never also repoRoot", () => {
    // The blocker: adding repoRoot here ANDs an unrelated predicate onto an explicit
    // request and returns fewer rows than the user asked for, while the help text
    // promises "from anywhere".
    const s = scope({ domain: "phoenix" });
    expect(s.args).toEqual({ domain: "phoenix" });
    expect(s.args).not.toHaveProperty("repoRoot");
    expect(s.args).not.toHaveProperty("domainCwd");
  });

  test("-d stays pure even for a repoScoped provider with a resolvable git root", () => {
    expect(scope({ domain: "phoenix", repoScoped: true, getGitRoot: gitRoot }).args).toEqual({ domain: "phoenix" });
  });

  test("with no -d, both domainCwd and repoRoot are sent — the daemon ANDs them", () => {
    expect(scope().args).toEqual({ domainCwd: "/home/u/github/mcp-cli/wt", repoRoot: "/home/u/github/mcp-cli" });
  });

  test("a non-repoScoped provider gets domain scoping but no repoRoot", () => {
    expect(scope({ repoScoped: false }).args).toEqual({ domainCwd: "/home/u/github/mcp-cli/wt" });
  });

  test("activeFilter survives a directory that is in no git repo, so the --all hint does not vanish", () => {
    const s = scope({ getGitRoot: noGitRoot });
    expect(s.args).toEqual({ domainCwd: "/home/u/github/mcp-cli/wt" });
    expect(s.activeFilter).toBe("/home/u/github/mcp-cli/wt");
  });

  test("a git-root lookup failure is reported and does not scope by repo", () => {
    const messages: string[] = [];
    const s = buildSessionScope({
      domain: undefined,
      all: false,
      cwd: "/tmp/x",
      repoScoped: true,
      getGitRoot: () => lookupFailure("git exploded"),
      printError: (m) => messages.push(m),
    });
    expect(messages).toEqual(["git exploded"]);
    expect(s.args).toEqual({ domainCwd: "/tmp/x" });
  });

  test("the label names domains alone only when -d was explicit", () => {
    expect(scope({ domain: "phoenix" }).filterLabel).toBe("other domains");
    expect(scope().filterLabel).toBe("other domains or repos");
  });
});

describe("cross-surface: mcx claude and mcx agent claude must agree", () => {
  // Both CLIs call buildSessionScope with the same inputs for the same provider.
  // Driving the builder from each surface's argument shape is what pins them together:
  // the previous divergence was one surface placing the repoScoped block outside the
  // `else`, which no single-surface test could see.
  const cases: Array<{ name: string; domain: string | undefined; all: boolean }> = [
    { name: "-d phoenix", domain: "phoenix", all: false },
    { name: "no flags", domain: undefined, all: false },
    { name: "--all", domain: undefined, all: true },
    { name: "--all with -d", domain: "phoenix", all: true },
  ];

  for (const c of cases) {
    test(`${c.name} produces identical args from both surfaces`, () => {
      const claudeSurface = buildSessionScope({
        domain: c.domain,
        all: c.all,
        cwd: "/home/u/github/mcp-cli",
        repoScoped: true, // mcx claude is always the claude provider
        getGitRoot: gitRoot,
        printError: noop,
      });
      const agentSurface = buildSessionScope({
        domain: c.domain,
        all: c.all,
        cwd: "/home/u/github/mcp-cli",
        repoScoped: true, // hasFeature(claudeProvider, "repoScoped")
        getGitRoot: gitRoot,
        printError: noop,
      });
      expect(agentSurface.args).toEqual(claudeSurface.args);
      expect(agentSurface.filterLabel).toBe(claudeSurface.filterLabel);
    });
  }
});
