import { describe, expect, it } from "bun:test";

import type { FileMeta } from "./_engine/file-loader";
import { evaluateRule } from "./_engine/rule";
import rule from "./capability-flag-handler.rule";

function makeFile(relPath: string, content: string): FileMeta {
  return {
    path: relPath,
    relPath,
    content,
    pkg: relPath.split("/").slice(0, 2).join("/"),
    isTest: false,
  };
}

const PROVIDER_PATH = "packages/core/src/agent-provider.ts";

function providerFile(registrations: string): FileMeta {
  return makeFile(PROVIDER_PATH, `function registerProvider(_p: unknown): void {}\n${registrations}`);
}

function sessionFile(prefix: string, name: string, content: string): FileMeta {
  return makeFile(`packages/daemon/src/${prefix}-session/${name}`, content);
}

function workerFile(prefix: string, content: string): FileMeta {
  return makeFile(`packages/daemon/src/${prefix}-session-worker.ts`, content);
}

function buildFiles(...metas: FileMeta[]): Map<string, FileMeta> {
  return new Map(metas.map((m) => [m.path, m]));
}

describe("capability-flag-handler", () => {
  it("skips non-provider files", () => {
    const file = makeFile("packages/core/src/other.ts", "costTracking: true");
    const violations = evaluateRule(rule, file, buildFiles(file));
    expect(violations).toHaveLength(0);
  });

  it("clean — false flags produce no violations", () => {
    const pf = providerFile(`
registerProvider({
	name: "safe",
	serverName: "_safe",
	toolPrefix: "safe",
	buildSpawnArgs: () => ({}),
	native: { costTracking: false, compactLog: false },
});
`);
    const violations = evaluateRule(rule, pf, buildFiles(pf));
    expect(violations).toHaveLength(0);
  });

  it("clean — costTracking with cost evidence in session dir", () => {
    const pf = providerFile(`
registerProvider({
	name: "good",
	serverName: "_good",
	toolPrefix: "good",
	buildSpawnArgs: () => ({}),
	native: { costTracking: true },
});
`);
    const sf = sessionFile("good", "state.ts", "this.cost = result.total_cost_usd;");
    const violations = evaluateRule(rule, pf, buildFiles(pf, sf));
    expect(violations).toHaveLength(0);
  });

  it("clean — compactLog with compact evidence in session dir", () => {
    const pf = providerFile(`
registerProvider({
	name: "good",
	serverName: "_good",
	toolPrefix: "good",
	buildSpawnArgs: () => ({}),
	native: { compactLog: true },
});
`);
    const sf = sessionFile("good", "ws-server.ts", "export function compactifyEntry(entry) {}");
    const violations = evaluateRule(rule, pf, buildFiles(pf, sf));
    expect(violations).toHaveLength(0);
  });

  it("clean — evidence in worker file counts", () => {
    const pf = providerFile(`
registerProvider({
	name: "good",
	serverName: "_good",
	toolPrefix: "good",
	buildSpawnArgs: () => ({}),
	native: { compactLog: true },
});
`);
    const wf = workerFile("good", "if (args.compact) { return compactifyEntry(e); }");
    const violations = evaluateRule(rule, pf, buildFiles(pf, wf));
    expect(violations).toHaveLength(0);
  });

  it("flagged — costTracking true but no session files", () => {
    const pf = providerFile(`
registerProvider({
	name: "bad",
	serverName: "_bad",
	toolPrefix: "bad",
	buildSpawnArgs: () => ({}),
	native: { costTracking: true },
});
`);
    const violations = evaluateRule(rule, pf, buildFiles(pf));
    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toContain("bad");
    expect(violations[0].snippet).toContain("costTracking");
  });

  it("flagged — compactLog true but no compact code in session", () => {
    const pf = providerFile(`
registerProvider({
	name: "bad",
	serverName: "_bad",
	toolPrefix: "bad",
	buildSpawnArgs: () => ({}),
	native: { compactLog: true },
});
`);
    const sf = sessionFile("bad", "state.ts", "export class SessionState {}");
    const violations = evaluateRule(rule, pf, buildFiles(pf, sf));
    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toContain("compactLog");
  });

  it("flagged — session files exist but with wrong evidence", () => {
    const pf = providerFile(`
registerProvider({
	name: "wrong",
	serverName: "_wrong",
	toolPrefix: "wrong",
	buildSpawnArgs: () => ({}),
	native: { costTracking: true },
});
`);
    const sf = sessionFile("wrong", "state.ts", "export function handleCompact() {}");
    const violations = evaluateRule(rule, pf, buildFiles(pf, sf));
    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toContain("costTracking");
  });

  it("multiple providers — only flags the one missing evidence", () => {
    const pf = providerFile(`
registerProvider({
	name: "has-cost",
	serverName: "_has",
	toolPrefix: "has",
	buildSpawnArgs: () => ({}),
	native: { costTracking: true },
});
registerProvider({
	name: "no-cost",
	serverName: "_no",
	toolPrefix: "no",
	buildSpawnArgs: () => ({}),
	native: { costTracking: true },
});
`);
    const sf = sessionFile("has", "state.ts", "this.cost = msg.total_cost_usd;");
    const violations = evaluateRule(rule, pf, buildFiles(pf, sf));
    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toContain("no-cost");
  });

  it("ACP variants share session dir via serverName", () => {
    const pf = providerFile(`
registerProvider({
	name: "grok",
	serverName: "_acp",
	toolPrefix: "acp",
	buildSpawnArgs: () => ({}),
	native: { costTracking: true },
});
`);
    const sf = sessionFile("acp", "event-map.ts", "state.cost = update.cost;");
    const violations = evaluateRule(rule, pf, buildFiles(pf, sf));
    expect(violations).toHaveLength(0);
  });

  it("ignores flags not in the evidence map", () => {
    const pf = providerFile(`
registerProvider({
	name: "headless",
	serverName: "_headless",
	toolPrefix: "headless",
	buildSpawnArgs: () => ({}),
	native: { headed: true, worktree: true, resume: true },
});
`);
    const violations = evaluateRule(rule, pf, buildFiles(pf));
    expect(violations).toHaveLength(0);
  });

  it("does not false-positive on the real provider file", async () => {
    const realProvider = Bun.file("packages/core/src/agent-provider.ts");
    const content = await realProvider.text();
    const pf: FileMeta = {
      path: PROVIDER_PATH,
      relPath: PROVIDER_PATH,
      content,
      pkg: "packages/core",
      isTest: false,
    };

    const glob = new Bun.Glob("packages/daemon/src/**/*.ts");
    const files = buildFiles(pf);
    for await (const path of glob.scan({ cwd: ".", absolute: false })) {
      if (path.includes(".spec.") || path.includes(".test.")) continue;
      const meta = makeFile(path, await Bun.file(path).text());
      files.set(meta.path, meta);
    }

    const violations = evaluateRule(rule, pf, files);
    expect(violations).toHaveLength(0);
  });
});
