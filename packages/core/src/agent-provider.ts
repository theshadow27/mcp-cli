/**
 * Agent provider registry and shim interface.
 *
 * Defines the common interface that all agent providers (Claude, Codex,
 * OpenCode, ACP, Copilot, Gemini) implement. The registry maps provider
 * names to their definitions and the shim registry provides feature
 * polyfills for providers that lack native support.
 */

// ── Types ──────────────────────────────────────────────────────────

export interface AgentFeatures {
  /** Native --worktree in subprocess */
  worktree: boolean;
  /** Native session resume */
  resume: boolean;
  /** Native repo-scoped session filtering */
  repoScoped: boolean;
  /** Native per-session cost events */
  costTracking: boolean;
  /** Native compact transcript mode */
  compactLog: boolean;
  /** Native cursor-based wait polling */
  afterSeq: boolean;
  /** Native TUI mode */
  headed: boolean;
  /** Agent sub-selection (ACP only) */
  agentSelect: boolean;
}

export interface CommonSpawnOpts {
  task: string;
  model?: string;
  cwd?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  wait?: boolean;
  timeout?: number;
  /** Provider-specific extras passed through */
  extras?: Record<string, unknown>;
}

export interface AgentProvider {
  /** Provider identifier: "claude", "codex", "acp", "opencode", "copilot", "gemini" */
  name: string;
  /** Daemon server name: "_claude", "_codex", "_acp", "_opencode" */
  serverName: string;
  /** Tool name prefix: "claude", "codex", "acp", "opencode" */
  toolPrefix: string;
  /** How to build provider-specific spawn args from common options */
  buildSpawnArgs(opts: CommonSpawnOpts): Record<string, unknown>;
  /** Native feature declarations — anything not listed here gets shimmed */
  native: Partial<AgentFeatures>;
}

export interface ShimContext {
  provider: AgentProvider;
  sessionId: string;
  spawnArgs: Record<string, unknown>;
}

export interface AgentShim {
  /** Feature this shim provides */
  feature: keyof AgentFeatures;
  /** Check if this shim should activate for the given provider */
  appliesTo(provider: AgentProvider): boolean;
  /** Pre-spawn hook: modify spawn args, set up environment */
  beforeSpawn?(ctx: ShimContext): Promise<void>;
  /** Post-bye hook: cleanup */
  afterBye?(ctx: ShimContext): Promise<void>;
}

// ── Provider Registry ──────────────────────────────────────────────

const providers = new Map<string, AgentProvider>();

export function registerProvider(provider: AgentProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name: string): AgentProvider | undefined {
  return providers.get(name);
}

export function getAllProviders(): AgentProvider[] {
  return [...providers.values()];
}

// ── Shim Registry ──────────────────────────────────────────────────

const shims: AgentShim[] = [];

export function registerShim(shim: AgentShim): void {
  shims.push(shim);
}

/** Return all shims that apply to the given provider (features it lacks natively). */
export function getShims(provider: AgentProvider): AgentShim[] {
  return shims.filter((s) => s.appliesTo(provider));
}

/** Return all registered shims. */
export function getAllShims(): AgentShim[] {
  return [...shims];
}

// ── Testing helpers ────────────────────────────────────────────────

/** Reset registries to empty state. For tests only. */
export function _resetRegistries(): void {
  providers.clear();
  shims.length = 0;
}

// ── Built-in Providers ─────────────────────────────────────────────

function passthrough(opts: CommonSpawnOpts): Record<string, unknown> {
  const args: Record<string, unknown> = { task: opts.task };
  if (opts.model) args.model = opts.model;
  if (opts.cwd) args.cwd = opts.cwd;
  if (opts.allowedTools) args.allowedTools = opts.allowedTools;
  if (opts.disallowedTools) args.disallowedTools = opts.disallowedTools;
  if (opts.wait) args.wait = opts.wait;
  if (opts.timeout) args.timeout = opts.timeout;
  return { ...args, ...opts.extras };
}

registerProvider({
  name: "claude",
  serverName: "_claude",
  toolPrefix: "claude",
  buildSpawnArgs: passthrough,
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
});

registerProvider({
  name: "codex",
  serverName: "_codex",
  toolPrefix: "codex",
  buildSpawnArgs: passthrough,
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
});

registerProvider({
  name: "opencode",
  serverName: "_opencode",
  toolPrefix: "opencode",
  buildSpawnArgs: passthrough,
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
});

registerProvider({
  name: "acp",
  serverName: "_acp",
  toolPrefix: "acp",
  buildSpawnArgs: passthrough,
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
});

/** Copilot is an ACP variant — same server, different agent selection. */
registerProvider({
  name: "copilot",
  serverName: "_acp",
  toolPrefix: "acp",
  buildSpawnArgs(opts: CommonSpawnOpts): Record<string, unknown> {
    return { ...passthrough(opts), agentOverride: "copilot" };
  },
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
});

/** Gemini is an ACP variant — same server, different agent selection. */
registerProvider({
  name: "gemini",
  serverName: "_acp",
  toolPrefix: "acp",
  buildSpawnArgs(opts: CommonSpawnOpts): Record<string, unknown> {
    return { ...passthrough(opts), agentOverride: "gemini" };
  },
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
});
