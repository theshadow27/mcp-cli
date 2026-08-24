/**
 * Provider-neutral agent session types.
 *
 * These types define the common interface that all agent providers
 * (Claude, Codex, OpenCode) implement. Provider-specific extensions
 * add their own fields on top of these.
 */

/**
 * Known agent providers. Uses `string & {}` to allow unknown providers
 * without requiring type changes — the DB stores plain TEXT.
 */
export type AgentProviderName = "claude" | "codex" | "opencode" | "acp" | (string & {});

export type AgentSessionState =
  | "connecting"
  | "init"
  | "active"
  | "waiting_permission"
  | "result"
  | "idle"
  | "disconnected"
  | "ended";

export interface AgentPermissionRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  inputSummary: string;
}

export interface AgentSessionInfo {
  sessionId: string;
  /** Human-readable session name (e.g. "Alice", "Bob"). Null if not assigned. */
  name: string | null;
  provider: AgentProviderName;
  state: AgentSessionState;
  model: string | null;
  cwd: string | null;
  /** Null when provider cannot compute cost. */
  cost: number | null;
  tokens: number;
  /** Reasoning/thinking tokens (Codex/OpenCode report this). */
  reasoningTokens: number;
  numTurns: number;
  pendingPermissions: number;
  pendingPermissionDetails: AgentPermissionRequest[];
  worktree: string | null;
  /** Git repo root the session was spawned in (null if unknown). */
  repoRoot: string | null;
  /**
   * The domain that owns this session, resolved from its spawn directory
   * (`NO_DOMAIN_ID` when the spawn directory is outside every registered domain).
   *
   * **Required, not optional, deliberately.** `agent_sessions` is a partitioned
   * table and a partition column that only some writers populate is worse than
   * none: it reads as "no sessions here" rather than "not recorded". Making the
   * field required means every provider that RETURNS this type fails to compile
   * until it supplies one — a type a caller cannot cast past rather than a
   * sentence in a doc.
   *
   * The guarantee is not total, and saying so matters more than the claim: the
   * mock worker hand-builds its listing object instead of returning
   * `AgentSessionInfo`, so it is outside this check and carries `domainId`
   * because someone remembered — the mechanism this comment argues against. What
   * covers mock instead is the `session-wait-domain-scoped` rule plus
   * `session-domain-roundtrip.spec.ts`, which drives mock's real worker. See
   * `docs/domains.md`.
   */
  domainId: number;
  /** Whether the agent process is still alive. */
  processAlive: boolean;
  /**
   * Whether the session is rate-limited by the API **right now** — not merely
   * "was, at some point in this turn". See `SessionState.rateLimited` (#3104).
   */
  rateLimited: boolean;
  /**
   * Epoch ms of the rate-limit signal behind `rateLimited`; null when the
   * session is not rate-limited. Absent when the provider does not track it.
   *
   * Renderers age the badge with it. A present-tense "[RATE LIMITED]" on a
   * session that has been producing tokens for ten minutes reads as a live
   * throttle and has repeatedly triggered false quota alarms; a timestamped
   * one cannot be misread that way.
   */
  rateLimitedAt?: number | null;
  /** Rate-limit signals behind `rateLimited` (0 when clear). Absent when the provider does not count them. */
  rateLimitHits?: number;
  /** Unix timestamp (ms) when this session was created. Null if unknown. */
  createdAt: number | null;
}

export interface AgentResult {
  result: string;
  cost: number | null;
  tokens: number;
  numTurns: number;
  diff?: string;
}

export type AgentSessionEvent =
  | { type: "session:init"; sessionId: string; provider: AgentProviderName; model: string; cwd: string }
  | { type: "session:response"; text: string }
  | { type: "session:permission_request"; request: AgentPermissionRequest }
  | { type: "session:result"; result: AgentResult }
  | { type: "session:error"; errors: string[]; cost: number | null }
  | { type: "session:disconnected"; reason: string }
  | { type: "session:containment_warning"; toolName: string; reason: string; strikes: number }
  | { type: "session:containment_denied"; toolName: string; reason: string; strikes: number }
  | { type: "session:ended" };
