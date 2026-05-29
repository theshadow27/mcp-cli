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
      permissionRoundtrip: true,
      multiTurn: true,
      interruptAck: true,
      toolCallReporting: true,
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
      permissionRoundtrip: false,
      multiTurn: true,
      interruptAck: false,
      toolCallReporting: true,
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
      permissionRoundtrip: false,
      multiTurn: true,
      interruptAck: false,
      toolCallReporting: false,
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
      permissionRoundtrip: false,
      multiTurn: true,
      interruptAck: false,
      toolCallReporting: false,
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
      permissionRoundtrip: false,
      multiTurn: true,
      interruptAck: false,
      toolCallReporting: false,
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
      permissionRoundtrip: false,
      multiTurn: true,
      interruptAck: false,
      toolCallReporting: false,
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
      permissionRoundtrip: false,
      multiTurn: true,
      interruptAck: false,
      toolCallReporting: false,
    },
  },
  mock: {
    serverName: "_mock",
    toolPrefix: "mock",
    native: {
      resume: false,
      permissionRoundtrip: true,
      multiTurn: true,
      interruptAck: true,
      toolCallReporting: true,
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

// ── Declaration verification ──────────────────────────────────────────────
//
// Verifies that every declared-true capability is actually present in the
// provider's native map, and that the new protocol-side features
// (permissionRoundtrip, multiTurn, interruptAck, toolCallReporting) are
// declared by the providers that support them.

const PROTOCOL_FEATURES = ["permissionRoundtrip", "multiTurn", "interruptAck", "toolCallReporting"] as const;

describe("protocol feature declarations", () => {
  for (const [name, shape] of Object.entries(PROVIDER_SHAPES) as [BuiltInProviderName, ProviderShapeExpectation][]) {
    for (const feature of PROTOCOL_FEATURES) {
      if (shape.native[feature] === true) {
        test(`${name} declares ${feature}=true and registration matches`, () => {
          const p = requireProvider(name);
          expect(p.native[feature]).toBe(true);
        });
      } else if (shape.native[feature] === false) {
        test(`${name} declares ${feature}=false and registration matches`, () => {
          const p = requireProvider(name);
          expect(p.native[feature]).toBe(false);
        });
      }
    }
  }

  test("mock declares all protocol features true", () => {
    const mock = requireProvider("mock");
    for (const feature of PROTOCOL_FEATURES) {
      expect(mock.native[feature]).toBe(true);
    }
  });

  test("claude declares all protocol features true", () => {
    const claude = requireProvider("claude");
    for (const feature of PROTOCOL_FEATURES) {
      expect(claude.native[feature]).toBe(true);
    }
  });
});

describe("declaration honesty verification", () => {
  /** Run the shape-assertion sweep: every feature declared true in PROVIDER_SHAPES must be true in the registry. Throws on mismatch. */
  function verifyDeclarationsMatch(): void {
    for (const [name, shape] of Object.entries(PROVIDER_SHAPES) as [BuiltInProviderName, ProviderShapeExpectation][]) {
      const provider = getProvider(name);
      if (!provider) continue;
      for (const [feature, expected] of Object.entries(shape.native) as [keyof AgentFeatures, boolean][]) {
        if (provider.native[feature] !== expected) {
          throw new Error(`${name}.native.${feature}: registry has ${provider.native[feature]}, expected ${expected}`);
        }
      }
    }
  }

  test("tampered declaration (true→false) is caught by shape assertion", () => {
    const saved = getAllProviders();
    try {
      const claude = requireProvider("claude");
      const tampered: AgentProvider = {
        ...claude,
        native: { ...claude.native, multiTurn: false },
      };
      _resetRegistries();
      registerProvider(tampered);
      expect(() => verifyDeclarationsMatch()).toThrow("claude.native.multiTurn: registry has false, expected true");
    } finally {
      _resetRegistries();
      for (const p of saved) registerProvider(p);
    }
  });

  test("tampered declaration (false→true) is caught by shape assertion", () => {
    const saved = getAllProviders();
    try {
      const codex = requireProvider("codex");
      const tampered: AgentProvider = {
        ...codex,
        native: { ...codex.native, permissionRoundtrip: true },
      };
      _resetRegistries();
      registerProvider(tampered);
      expect(() => verifyDeclarationsMatch()).toThrow(
        "codex.native.permissionRoundtrip: registry has true, expected false",
      );
    } finally {
      _resetRegistries();
      for (const p of saved) registerProvider(p);
    }
  });

  test("untampered providers pass the shape assertion sweep", () => {
    expect(() => verifyDeclarationsMatch()).not.toThrow();
  });

  test("every provider with declared-true features has them in the registry", () => {
    for (const [name, shape] of Object.entries(PROVIDER_SHAPES) as [BuiltInProviderName, ProviderShapeExpectation][]) {
      const provider = getProvider(name);
      if (!provider) continue;
      for (const [feature, expected] of Object.entries(shape.native) as [keyof AgentFeatures, boolean][]) {
        if (expected) {
          expect(provider.native[feature]).toBe(true);
        }
      }
    }
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
