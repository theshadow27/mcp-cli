import { afterEach, describe, expect, test } from "bun:test";
import {
  type AgentProvider,
  type AgentShim,
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

describe("agent-provider", () => {
  describe("built-in providers", () => {
    test("claude provider is registered with full native features", () => {
      const claude = requireProvider("claude");
      expect(claude.name).toBe("claude");
      expect(claude.serverName).toBe("_claude");
      expect(claude.toolPrefix).toBe("claude");
      expect(claude.native.worktree).toBe(true);
      expect(claude.native.resume).toBe(true);
      expect(claude.native.repoScoped).toBe(true);
      expect(claude.native.costTracking).toBe(true);
      expect(claude.native.compactLog).toBe(true);
      expect(claude.native.afterSeq).toBe(true);
      expect(claude.native.headed).toBe(true);
      expect(claude.native.agentSelect).toBe(false);
    });

    test("codex provider is registered", () => {
      const codex = requireProvider("codex");
      expect(codex.serverName).toBe("_codex");
      expect(codex.toolPrefix).toBe("codex");
      expect(codex.native.worktree).toBe(false);
      expect(codex.native.costTracking).toBe(true);
    });

    test("opencode provider is registered", () => {
      const oc = requireProvider("opencode");
      expect(oc.serverName).toBe("_opencode");
      expect(oc.toolPrefix).toBe("opencode");
      expect(oc.native.headed).toBe(false);
    });

    test("acp provider is registered", () => {
      const acp = requireProvider("acp");
      expect(acp.serverName).toBe("_acp");
      expect(acp.toolPrefix).toBe("acp");
      expect(acp.native.agentSelect).toBe(true);
    });

    test("copilot is an ACP variant with agentOverride", () => {
      const copilot = requireProvider("copilot");
      expect(copilot.serverName).toBe("_acp");
      expect(copilot.toolPrefix).toBe("acp");
      const args = copilot.buildSpawnArgs({ task: "test" });
      expect(args.agentOverride).toBe("copilot");
    });

    test("gemini is an ACP variant with agentOverride", () => {
      const gemini = requireProvider("gemini");
      expect(gemini.serverName).toBe("_acp");
      const args = gemini.buildSpawnArgs({ task: "test" });
      expect(args.agentOverride).toBe("gemini");
    });

    test("getAllProviders returns all 6 built-in providers", () => {
      const all = getAllProviders();
      const names = all.map((p) => p.name).sort();
      expect(names).toEqual(["acp", "claude", "codex", "copilot", "gemini", "opencode"]);
    });

    test("unknown provider returns undefined", () => {
      expect(getProvider("nonexistent")).toBeUndefined();
    });
  });

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

    test("copilot injects agentOverride into spawn args", () => {
      const copilot = requireProvider("copilot");
      const args = copilot.buildSpawnArgs({ task: "test", extras: { foo: 1 } });
      expect(args.agentOverride).toBe("copilot");
      expect(args.foo).toBe(1);
    });
  });

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

  describe("_resetRegistries", () => {
    test("clears all providers and shims", () => {
      _resetRegistries();
      expect(getAllProviders()).toEqual([]);
      expect(getAllShims()).toEqual([]);
    });
  });
});
