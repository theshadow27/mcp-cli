/**
 * Agent provider registry — maps provider names to server/tool configuration.
 *
 * Each provider has a daemon server name (e.g. "_claude") and a tool prefix
 * (e.g. "claude") used to construct tool names like "claude_prompt".
 *
 * This is the foundation for `mcx agent <provider> <subcommand>` — the unified
 * command dispatches subcommands parameterized by the provider config here.
 */

import { ACP_SERVER_NAME, CLAUDE_SERVER_NAME, CODEX_SERVER_NAME, OPENCODE_SERVER_NAME } from "./constants";

/** Static configuration for an agent provider. */
export interface AgentProviderConfig {
  /** Provider identifier: "claude", "codex", "opencode", "acp" */
  readonly name: string;
  /** Display name for user-facing messages: "Claude", "Codex", "OpenCode", "ACP" */
  readonly displayName: string;
  /** Daemon virtual server name: "_claude", "_codex", "_acp", "_opencode" */
  readonly serverName: string;
  /** Tool name prefix: "claude", "codex", "acp", "opencode" */
  readonly toolPrefix: string;
  /** Native feature flags — controls which subcommands/options are available. */
  readonly features: AgentFeatures;
}

/** Feature flags declaring native capabilities per provider. */
export interface AgentFeatures {
  /** Native --worktree in subprocess (all providers support via mcx shim). */
  readonly worktree: boolean;
  /** Native session resume (only Claude). */
  readonly resume: boolean;
  /** Native repo-scoped session filtering (only Claude). */
  readonly repoScoped: boolean;
  /** Native per-session cost events. */
  readonly costTracking: boolean;
  /** Native compact transcript mode. */
  readonly compactLog: boolean;
  /** Native cursor-based wait polling. */
  readonly afterSeq: boolean;
  /** Native TUI mode (--headed, only Claude). */
  readonly headed: boolean;
  /** Agent sub-selection (--agent flag, ACP only). */
  readonly agentSelect: boolean;
  /** Provider sub-selection (--provider flag, OpenCode only). */
  readonly providerSelect: boolean;
}

// ── Built-in providers ──

const CLAUDE_PROVIDER: AgentProviderConfig = {
  name: "claude",
  displayName: "Claude",
  serverName: CLAUDE_SERVER_NAME,
  toolPrefix: "claude",
  features: {
    worktree: true,
    resume: true,
    repoScoped: true,
    costTracking: true,
    compactLog: true,
    afterSeq: true,
    headed: true,
    agentSelect: false,
    providerSelect: false,
  },
};

const CODEX_PROVIDER: AgentProviderConfig = {
  name: "codex",
  displayName: "Codex",
  serverName: CODEX_SERVER_NAME,
  toolPrefix: "codex",
  features: {
    worktree: true,
    resume: false,
    repoScoped: false,
    costTracking: false,
    compactLog: false,
    afterSeq: true,
    headed: false,
    agentSelect: false,
    providerSelect: false,
  },
};

const OPENCODE_PROVIDER: AgentProviderConfig = {
  name: "opencode",
  displayName: "OpenCode",
  serverName: OPENCODE_SERVER_NAME,
  toolPrefix: "opencode",
  features: {
    worktree: true,
    resume: false,
    repoScoped: false,
    costTracking: true,
    compactLog: false,
    afterSeq: true,
    headed: false,
    agentSelect: false,
    providerSelect: true,
  },
};

const ACP_PROVIDER: AgentProviderConfig = {
  name: "acp",
  displayName: "ACP",
  serverName: ACP_SERVER_NAME,
  toolPrefix: "acp",
  features: {
    worktree: true,
    resume: false,
    repoScoped: false,
    costTracking: false,
    compactLog: false,
    afterSeq: true,
    headed: false,
    agentSelect: true,
    providerSelect: false,
  },
};

/** All registered providers, keyed by name. */
const PROVIDERS: ReadonlyMap<string, AgentProviderConfig> = new Map([
  ["claude", CLAUDE_PROVIDER],
  ["codex", CODEX_PROVIDER],
  ["opencode", OPENCODE_PROVIDER],
  ["acp", ACP_PROVIDER],
  // Aliases — these are ACP variants with a fixed agent override
  ["copilot", ACP_PROVIDER],
  ["gemini", ACP_PROVIDER],
]);

/**
 * Look up a provider by name. Returns undefined if not found.
 */
export function getProvider(name: string): AgentProviderConfig | undefined {
  return PROVIDERS.get(name);
}

/**
 * List all registered provider names (excluding aliases like copilot/gemini).
 */
export function listProviders(): string[] {
  return ["claude", "codex", "opencode", "acp"];
}

/**
 * List all provider names including aliases.
 */
export function listAllProviderNames(): string[] {
  return [...PROVIDERS.keys()];
}
