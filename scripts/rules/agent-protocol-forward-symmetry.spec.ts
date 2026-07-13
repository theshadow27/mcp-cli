import { describe, expect, it } from "bun:test";

import type { FileMeta } from "./_engine/file-loader";
import { loadFiles } from "./_engine/file-loader";
import { evaluateRule, validateAnchors } from "./_engine/rule";
import rule, { extractForwardHandler } from "./agent-protocol-forward-symmetry.rule";

const repoRoot = process.cwd();
const ANCHOR = "packages/daemon/src/abstract-worker-server.ts";

function workerFile(provider: string, cases: string[], paramType = "AgentSessionEvent"): FileMeta {
  const relPath = `packages/daemon/src/${provider}-session-worker.ts`;
  const body = cases.map((c) => `    case "${c}": break;`).join("\n");
  return {
    path: `/x/${relPath}`,
    relPath,
    content: `function forwardSessionEvent(sessionId: string, event: ${paramType}): void {\n  switch (event.type) {\n${body}\n  }\n}`,
    pkg: "packages/daemon",
    isTest: false,
  };
}

function anchorFile(): FileMeta {
  return {
    path: `/x/${ANCHOR}`,
    relPath: ANCHOR,
    content: "export const BASE_WORKER_EVENT_TYPES = new Set([]);",
    pkg: "packages/daemon",
    isTest: false,
  };
}

describe("extractForwardHandler", () => {
  it("extracts the event param type and session:* cases", () => {
    const src = `function forwardSessionEvent(sessionId: string, event: AgentSessionEvent): void {
      switch (event.type) {
        case "session:init": break;
        case "session:ended": break;
        case "db:noise": break;
      }
    }`;
    const h = extractForwardHandler(src);
    expect(h?.paramType).toBe("AgentSessionEvent");
    expect(h?.cases).toEqual(["session:ended", "session:init"]);
  });

  it("returns undefined when there is no forwardSessionEvent", () => {
    expect(extractForwardHandler("function other() {}")).toBeUndefined();
  });
});

describe("agent-protocol-forward-symmetry rule", () => {
  it("passes on the real repo — providers sharing a vocabulary are symmetric", async () => {
    const files = await loadFiles({ repoRoot });
    validateAnchors(rule, files);
    const anchor = [...files.values()].find((f) => f.relPath === ANCHOR);
    if (!anchor) throw new Error("anchor file not loaded");
    expect(evaluateRule(rule, anchor, files)).toEqual([]);
  });

  it("flags a provider missing a case its peer handles", () => {
    const anchor = anchorFile();
    const acp = workerFile("acp", ["session:init", "session:ended", "session:disconnected"]);
    const codex = workerFile("codex", ["session:init", "session:ended"]); // drops disconnected
    const files = new Map([acp, codex, anchor].map((f) => [f.path, f]));
    const violations = evaluateRule(rule, anchor, files);
    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toContain("codex");
    expect(violations[0].snippet).toContain("session:disconnected");
    expect(violations[0].snippet).toContain("acp");
  });

  it("does not compare across different event parameter types", () => {
    const anchor = anchorFile();
    const acp = workerFile("acp", ["session:init", "session:permission_request"], "AgentSessionEvent");
    const claude = workerFile("claude", ["session:init", "session:cleared"], "SessionEvent");
    const files = new Map([acp, claude, anchor].map((f) => [f.path, f]));
    // acp and claude are in different symmetry classes (each a class of 1) — no violation.
    expect(evaluateRule(rule, anchor, files)).toEqual([]);
  });

  it("does not fire when a shared-vocabulary class is fully symmetric", () => {
    const anchor = anchorFile();
    const acp = workerFile("acp", ["session:init", "session:ended"]);
    const codex = workerFile("codex", ["session:ended", "session:init"]); // same set, reordered
    const files = new Map([acp, codex, anchor].map((f) => [f.path, f]));
    expect(evaluateRule(rule, anchor, files)).toEqual([]);
  });

  it("does not run on non-anchor files", () => {
    const acp = workerFile("acp", ["session:init"]);
    const files = new Map([[acp.path, acp]]);
    expect(evaluateRule(rule, acp, files)).toEqual([]);
  });
});
