import { describe, expect, test } from "bun:test";
import { getProvider, listAllProviderNames, listProviders } from "./agent-provider";

describe("getProvider", () => {
  test("returns Claude provider config", () => {
    const p = getProvider("claude");
    expect(p).toBeDefined();
    expect(p?.name).toBe("claude");
    expect(p?.serverName).toBe("_claude");
    expect(p?.toolPrefix).toBe("claude");
    expect(p?.features.resume).toBe(true);
    expect(p?.features.headed).toBe(true);
    expect(p?.features.repoScoped).toBe(true);
  });

  test("returns Codex provider config", () => {
    const p = getProvider("codex");
    expect(p).toBeDefined();
    expect(p?.name).toBe("codex");
    expect(p?.serverName).toBe("_codex");
    expect(p?.toolPrefix).toBe("codex");
    expect(p?.features.resume).toBe(false);
    expect(p?.features.costTracking).toBe(false);
  });

  test("returns ACP provider config", () => {
    const p = getProvider("acp");
    expect(p).toBeDefined();
    expect(p?.name).toBe("acp");
    expect(p?.toolPrefix).toBe("acp");
    expect(p?.features.agentSelect).toBe(true);
  });

  test("returns OpenCode provider config", () => {
    const p = getProvider("opencode");
    expect(p).toBeDefined();
    expect(p?.name).toBe("opencode");
    expect(p?.toolPrefix).toBe("opencode");
    expect(p?.features.providerSelect).toBe(true);
    expect(p?.features.costTracking).toBe(true);
  });

  test("copilot resolves to ACP provider", () => {
    const p = getProvider("copilot");
    expect(p).toBeDefined();
    expect(p?.name).toBe("acp");
    expect(p?.toolPrefix).toBe("acp");
  });

  test("gemini resolves to ACP provider", () => {
    const p = getProvider("gemini");
    expect(p).toBeDefined();
    expect(p?.name).toBe("acp");
  });

  test("returns undefined for unknown provider", () => {
    expect(getProvider("unknown")).toBeUndefined();
  });
});

describe("listProviders", () => {
  test("returns core providers without aliases", () => {
    const providers = listProviders();
    expect(providers).toContain("claude");
    expect(providers).toContain("codex");
    expect(providers).toContain("opencode");
    expect(providers).toContain("acp");
    expect(providers).not.toContain("copilot");
    expect(providers).not.toContain("gemini");
  });
});

describe("listAllProviderNames", () => {
  test("includes aliases", () => {
    const names = listAllProviderNames();
    expect(names).toContain("copilot");
    expect(names).toContain("gemini");
    expect(names).toContain("claude");
  });
});
