import { describe, expect, it } from "bun:test";

import type { FileMeta } from "./_engine/file-loader";
import { evaluateRule } from "./_engine/rule";
import rule from "./acp-cost-tracking-evidence.rule";

const PROVIDER_PATH = "packages/core/src/agent-provider.ts";
const SPEC_PATH = "packages/acp/src/acp-event-map.spec.ts";

function makeFile(relPath: string, content: string): FileMeta {
  return { path: relPath, relPath, content, pkg: relPath.split("/").slice(0, 2).join("/"), isTest: false };
}

const PROVIDER_WITH_ACP_COST_TRACKING = `
registerProvider({
  name: "grok",
  serverName: "_acp",
  native: { costTracking: true },
});
`;

const PROVIDER_WITHOUT_ACP_COST_TRACKING = `
registerProvider({
  name: "copilot",
  serverName: "_acp",
  native: { costTracking: false },
});
`;

const PROVIDER_NON_ACP_COST_TRACKING = `
registerProvider({
  name: "opencode",
  serverName: "_opencode",
  native: { costTracking: true },
});
`;

const SPEC_WITH_EVIDENCE = `
test("session_info_update tracks tokens and cost", () => {
  const state = createAcpEventMapState();
  mapSessionUpdate({ update: { sessionUpdate: "session_info_update", cost: 0.005 } }, state);
  expect(state.cost).toBe(0.005);
});
`;

const SPEC_WITHOUT_COST_ASSERTION = `
test("session_info_update tracks tokens", () => {
  const state = createAcpEventMapState();
  mapSessionUpdate({ update: { sessionUpdate: "session_info_update" } }, state);
  expect(state.totalTokens).toBe(0);
});
`;

const SPEC_WITHOUT_SESSION_INFO = `
test("agent_message_chunk", () => {
  const state = createAcpEventMapState();
  expect(state.cost).toBeNull();
});
`;

// Spec that has state.cost as a setup *assignment* (not an expect assertion) alongside
// a session_info_update string — the raw-includes check would pass this; the fixed
// expect(state.cost check must flag it.
const SPEC_WITH_COST_ASSIGNMENT_ONLY = `
describe("buildTurnResult", () => {
  test("maps cost", () => {
    const state = createAcpEventMapState();
    state.cost = 0.01;
    mapSessionUpdate({ update: { sessionUpdate: "session_info_update" } }, state);
    expect(state.totalTokens).toBe(0);
  });
});
`;

// Single-quoted variant of the session_info_update signal — biome may rewrite quotes.
const SPEC_WITH_SINGLE_QUOTE_EVIDENCE = `
test('session_info_update tracks cost', () => {
  const state = createAcpEventMapState();
  mapSessionUpdate({ update: { sessionUpdate: 'session_info_update', cost: 0.005 } }, state);
  expect(state.cost).toBe(0.005);
});
`;

describe("acp-cost-tracking-evidence: provider file check", () => {
  it("does not fire when costTracking: false on _acp provider", () => {
    const provider = makeFile(PROVIDER_PATH, PROVIDER_WITHOUT_ACP_COST_TRACKING);
    const violations = evaluateRule(rule, provider, new Map([[provider.path, provider]]));
    expect(violations).toHaveLength(0);
  });

  it("does not fire when costTracking: true on non-ACP provider", () => {
    const provider = makeFile(PROVIDER_PATH, PROVIDER_NON_ACP_COST_TRACKING);
    const violations = evaluateRule(rule, provider, new Map([[provider.path, provider]]));
    expect(violations).toHaveLength(0);
  });

  it("does not run on non-provider files", () => {
    const other = makeFile("packages/command/src/commands/agent.ts", PROVIDER_WITH_ACP_COST_TRACKING);
    const violations = evaluateRule(rule, other, new Map([[other.path, other]]));
    expect(violations).toHaveLength(0);
  });

  it("does not run on test files (appliesToTests: false)", () => {
    const testFile: FileMeta = { ...makeFile(PROVIDER_PATH, PROVIDER_WITH_ACP_COST_TRACKING), isTest: true };
    const violations = evaluateRule(rule, testFile, new Map([[testFile.path, testFile]]));
    expect(violations).toHaveLength(0);
  });
});

describe("acp-cost-tracking-evidence: cross-file evidence check", () => {
  it("flags costTracking: true on _acp when spec is absent from files map", () => {
    const provider = makeFile(PROVIDER_PATH, PROVIDER_WITH_ACP_COST_TRACKING);
    const violations = evaluateRule(rule, provider, new Map([[provider.path, provider]]));
    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toContain("costTracking: true");
  });

  it("flags costTracking: true on _acp when spec lacks session_info_update", () => {
    const provider = makeFile(PROVIDER_PATH, PROVIDER_WITH_ACP_COST_TRACKING);
    const spec = makeFile(SPEC_PATH, SPEC_WITHOUT_SESSION_INFO);
    const files = new Map([
      [provider.path, provider],
      [spec.path, spec],
    ]);
    const violations = evaluateRule(rule, provider, files);
    expect(violations).toHaveLength(1);
  });

  it("flags costTracking: true on _acp when spec has session_info_update but no state.cost assertion", () => {
    const provider = makeFile(PROVIDER_PATH, PROVIDER_WITH_ACP_COST_TRACKING);
    const spec = makeFile(SPEC_PATH, SPEC_WITHOUT_COST_ASSERTION);
    const files = new Map([
      [provider.path, provider],
      [spec.path, spec],
    ]);
    const violations = evaluateRule(rule, provider, files);
    expect(violations).toHaveLength(1);
  });

  it("does not flag costTracking: true on _acp when spec has full evidence", () => {
    const provider = makeFile(PROVIDER_PATH, PROVIDER_WITH_ACP_COST_TRACKING);
    const spec = makeFile(SPEC_PATH, SPEC_WITH_EVIDENCE);
    const files = new Map([
      [provider.path, provider],
      [spec.path, spec],
    ]);
    const violations = evaluateRule(rule, provider, files);
    expect(violations).toHaveLength(0);
  });

  it("flags only the _acp providers with costTracking: true, not the false ones", () => {
    const content = `
      registerProvider({ name: "grok",    serverName: "_acp",      native: { costTracking: true } });
      registerProvider({ name: "gemini",  serverName: "_acp",      native: { costTracking: false } });
      registerProvider({ name: "opencode", serverName: "_opencode", native: { costTracking: true } });
    `;
    const provider = makeFile(PROVIDER_PATH, content);
    const violations = evaluateRule(rule, provider, new Map([[provider.path, provider]]));
    expect(violations).toHaveLength(1);
    expect(violations[0].snippet).toContain("costTracking: true");
  });

  it("flags costTracking: true when spec has state.cost assignment but no expect(state.cost)", () => {
    const provider = makeFile(PROVIDER_PATH, PROVIDER_WITH_ACP_COST_TRACKING);
    const spec = makeFile(SPEC_PATH, SPEC_WITH_COST_ASSIGNMENT_ONLY);
    const files = new Map([
      [provider.path, provider],
      [spec.path, spec],
    ]);
    const violations = evaluateRule(rule, provider, files);
    expect(violations).toHaveLength(1);
  });

  it("does not flag when spec uses single-quoted session_info_update with expect(state.cost)", () => {
    const provider = makeFile(PROVIDER_PATH, PROVIDER_WITH_ACP_COST_TRACKING);
    const spec = makeFile(SPEC_PATH, SPEC_WITH_SINGLE_QUOTE_EVIDENCE);
    const files = new Map([
      [provider.path, provider],
      [spec.path, spec],
    ]);
    const violations = evaluateRule(rule, provider, files);
    expect(violations).toHaveLength(0);
  });

  it("evidence in spec clears violations for all _acp providers in the file", () => {
    const content = `
      registerProvider({ name: "grok",   serverName: "_acp", native: { costTracking: true } });
      registerProvider({ name: "copilot", serverName: "_acp", native: { costTracking: true } });
    `;
    const provider = makeFile(PROVIDER_PATH, content);
    const spec = makeFile(SPEC_PATH, SPEC_WITH_EVIDENCE);
    const files = new Map([
      [provider.path, provider],
      [spec.path, spec],
    ]);
    const violations = evaluateRule(rule, provider, files);
    expect(violations).toHaveLength(0);
  });
});
