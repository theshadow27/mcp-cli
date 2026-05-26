import { afterEach, describe, expect, test } from "bun:test";
import {
  type AgentFeatures,
  type AgentProvider,
  type AgentShim,
  type BuiltInProviderName,
  _resetRegistries,
  getAllProviders,
  getAllShims,
  getProvider,
  getShims,
  registerProvider,
  registerShim,
} from "./agent-provider";

/** Lookup helper that fails the test if the provider is missing. */
function requireProvider(name: string): AgentProvider {
  const p = getProvider(name);
  expect(p).toBeDefined();
  return p as AgentProvider;
}

// ── Capability shape table ─────────────────────────────────────────────────
//
// Record<BuiltInProviderName, ...> is exhaustive by construction: TypeScript
// will fail to compile if a BuiltInProviderName member is missing from the
// table or if the type is widened. Adding a new built-in provider requires:
//   1. Extending BuiltInProviderName in agent-provider.ts
//   2. Adding an entry here — compile error enforces it.
//
// `agentOverride` is present for ACP variants that inject it into spawn args.

interface ProviderShapeExpectation {
  serverName: string;
  toolPrefix: string;
  native: Partial<AgentFeatures>;
  agentOverride?: string;
}

const PROVIDER_SHAPES: Record<BuiltInProviderName, ProviderShapeExpectation> = {
  claude: {
    serverName: "_claude",
    toolPrefix: "claude",
    native: {
      worktree: true,
      resume: true,
      repoScoped: true,
      costTracking: true,
      compactLog: true,
      afterSeq: true,
      headed: true,
      agentSelect: false,
    },
  },
  codex: {
    serverName: "_codex",
    toolPrefix: "codex",
    native: {
      worktree: false,
      resume: false,
      repoScoped: false,
      costTracking: true,
      compactLog: false,
      afterSeq: false,
      headed: true,
      agentSelect: false,
    },
  },
  opencode: {
    serverName: "_opencode",
    toolPrefix: "opencode",
    native: {
      worktree: false,
      resume: false,
      repoScoped: false,
      costTracking: true,
      compactLog: false,
      afterSeq: false,
      headed: false,
      agentSelect: false,
    },
  },
  acp: {
    serverName: "_acp",
    toolPrefix: "acp",
    native: {
      worktree: false,
      resume: false,
      repoScoped: false,
      costTracking: false,
      compactLog: false,
      afterSeq: false,
      headed: false,
      agentSelect: true,
    },
  },
  copilot: {
    serverName: "_acp",
    toolPrefix: "acp",
    agentOverride: "copilot",
    native: {
      worktree: false,
      resume: false,
      repoScoped: false,
      costTracking: false,
      compactLog: false,
      afterSeq: false,
      headed: false,
      agentSelect: true,
    },
  },
  gemini: {
    serverName: "_acp",
    toolPrefix: "acp",
    agentOverride: "gemini",
    native: {
      worktree: false,
      resume: false,
      repoScoped: false,
      costTracking: false,
      compactLog: false,
      afterSeq: false,
      headed: false,
      agentSelect: true,
    },
  },
  grok: {
    serverName: "_acp",
    toolPrefix: "acp",
    agentOverride: "grok",
    native: {
      worktree: false,
      resume: false,
      repoScoped: false,
      costTracking: false,
      compactLog: false,
      afterSeq: false,
      headed: false,
      agentSelect: true,
    },
  },
  mock: {
    serverName: "_mock",
    toolPrefix: "mock",
    native: {
      resume: false,
    },
  },
};

// ── Cardinality ────────────────────────────────────────────────────────────

describe("built-in provider cardinality", () => {
  // Iterating PROVIDER_SHAPES keys keeps the cardinality assertion in sync
  // with the shape table automatically. No getAllProviders() enumeration needed.
  for (const name of Object.keys(PROVIDER_SHAPES) as BuiltInProviderName[]) {
    test(`${name} is registered`, () => {
      expect(getProvider(name)).toBeDefined();
    });
  }

  test("unknown provider returns undefined", () => {
    expect(getProvider("nonexistent")).toBeUndefined();
  });
});

// ── Capability shapes ──────────────────────────────────────────────────────

describe("built-in provider capability shapes", () => {
  for (const [name, shape] of Object.entries(PROVIDER_SHAPES) as [BuiltInProviderName, ProviderShapeExpectation][]) {
    test(`${name}: serverName and toolPrefix`, () => {
      const p = requireProvider(name);
      expect(p.serverName).toBe(shape.serverName);
      expect(p.toolPrefix).toBe(shape.toolPrefix);
    });

    test(`${name}: native feature flags`, () => {
      const p = requireProvider(name);
      for (const [flag, expected] of Object.entries(shape.native) as [keyof AgentFeatures, boolean][]) {
        expect(p.native[flag]).toBe(expected);
      }
    });

    if (shape.agentOverride !== undefined) {
      const expectedOverride = shape.agentOverride;
      test(`${name}: buildSpawnArgs injects agentOverride="${expectedOverride}"`, () => {
        const p = requireProvider(name);
        const args = p.buildSpawnArgs({ task: "test" });
        expect(args.agentOverride).toBe(expectedOverride);
      });
    }
  }
});

// ── buildSpawnArgs: shared behavior ───────────────────────────────────────

describe("buildSpawnArgs", () => {
  test("claude passes through all common options", () => {
    const claude = requireProvider("claude");
    const args = claude.buildSpawnArgs({
      task: "implement feature",
      model: "opus",
      cwd: "/tmp",
      allowedTools: ["read"],
      disallowedTools: ["write"],
      wait: true,
      timeout: 5000,
      extras: { custom: "value" },
    });
    expect(args.task).toBe("implement feature");
    expect(args.model).toBe("opus");
    expect(args.cwd).toBe("/tmp");
    expect(args.allowedTools).toEqual(["read"]);
    expect(args.wait).toBe(true);
    expect(args.custom).toBe("value");
  });

  test("mock passes through task", () => {
    const mock = requireProvider("mock");
    const args = mock.buildSpawnArgs({ task: "/path/to/script.json" });
    expect(args.task).toBe("/path/to/script.json");
  });

  test("copilot injects agentOverride into spawn args alongside extras", () => {
    const copilot = requireProvider("copilot");
    const args = copilot.buildSpawnArgs({ task: "test", extras: { foo: 1 } });
    expect(args.agentOverride).toBe("copilot");
    expect(args.foo).toBe(1);
  });

  test("extras cannot overwrite explicit fields", () => {
    const claude = requireProvider("claude");
    const args = claude.buildSpawnArgs({
      task: "real task",
      model: "opus",
      cwd: "/safe",
      extras: { task: "", model: "haiku", cwd: "/evil" },
    });
    expect(args.task).toBe("real task");
    expect(args.model).toBe("opus");
    expect(args.cwd).toBe("/safe");
  });
});

// ── Shim registry ──────────────────────────────────────────────────────────

describe("shim registry", () => {
  afterEach(() => {
    const builtInProviders = getAllProviders();
    _resetRegistries();
    for (const p of builtInProviders) registerProvider(p);
  });

  test("getShims returns empty array when no shims registered", () => {
    const claude = requireProvider("claude");
    expect(getShims(claude)).toEqual([]);
  });

  test("shim applies to providers lacking the feature", () => {
    const worktreeShim: AgentShim = {
      feature: "worktree",
      appliesTo: (p: AgentProvider) => !p.native.worktree,
    };
    registerShim(worktreeShim);

    const claude = requireProvider("claude");
    const codex = requireProvider("codex");

    // Claude has native worktree — shim should NOT apply
    expect(getShims(claude)).toEqual([]);
    // Codex lacks native worktree — shim SHOULD apply
    expect(getShims(codex)).toEqual([worktreeShim]);
  });

  test("multiple shims can apply to the same provider", () => {
    const shimA: AgentShim = {
      feature: "worktree",
      appliesTo: (p: AgentProvider) => !p.native.worktree,
    };
    const shimB: AgentShim = {
      feature: "resume",
      appliesTo: (p: AgentProvider) => !p.native.resume,
    };
    registerShim(shimA);
    registerShim(shimB);

    const codex = requireProvider("codex");
    expect(getShims(codex)).toEqual([shimA, shimB]);
  });

  test("getAllShims returns all registered shims", () => {
    const shim: AgentShim = {
      feature: "worktree",
      appliesTo: () => true,
    };
    registerShim(shim);
    expect(getAllShims()).toEqual([shim]);
  });
});

// ── _resetRegistries ───────────────────────────────────────────────────────

describe("_resetRegistries", () => {
  test("clears all providers and shims then restores", () => {
    const saved = getAllProviders();
    _resetRegistries();
    expect(getAllProviders()).toEqual([]);
    expect(getAllShims()).toEqual([]);
    // Restore so subsequent tests in the same worker aren't poisoned
    for (const p of saved) registerProvider(p);
  });
});
