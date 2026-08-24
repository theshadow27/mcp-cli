/**
 * Unified monitor event envelope.
 *
 * Every event source in the daemon maps its native events into this shape
 * before publishing to the EventBus. Consumers (SSE streams, TUI, etc.)
 * subscribe to a single typed stream instead of polling three separate silos.
 *
 * Part of #1486 (monitor epic), introduced in #1512.
 * Projection layer (formatters, chunk suppression) added in #1515.
 *
 * ## Envelope contract (#1924)
 *
 * `enrichMonitorEvent` is the single enforcement point. It runs on every event
 * published through `EventBus.publish`, on every event replayed from the event
 * log, and on the synthesized NDJSON heartbeat. It does not trust producer
 * input: the type-level guards below only bind on typed call sites, and two
 * ingress paths (the `publishEvent` IPC `extra` record and automation
 * `emit-event`) spread caller-supplied keys the compiler cannot see.
 *
 * - **Flat.** Category-specific fields live at the top level of the envelope.
 *   A nested `payload` object is forbidden — `payload?: never` on
 *   `MonitorEventBase` rejects it at typed call sites, and `enrichMonitorEvent`
 *   deletes it at runtime for everything else. Consumers never need `.payload.x`.
 * - **`summary`** — a one-line description rendered from the shared per-type
 *   formatters, so consumers get a usable preview without reimplementing the
 *   formatter switch. Newlines are collapsed, the string is trimmed and capped
 *   at 120 chars, and it is never empty. A producer-supplied `summary` is
 *   preferred but is normalized the same way.
 * - **`severity`** — actionability tier (`info` | `notable` | `actionable` |
 *   `urgent`). A producer-supplied value is used only if it is one of those
 *   four; anything else falls back to the classification table. Consumers
 *   filter with `select(.severity == "actionable" or .severity == "urgent")`
 *   instead of maintaining their own event-name whitelist.
 *
 * Both fields are typed optional for one release of bake-in, so that a consumer
 * talking to a pre-#1924 daemon still typechecks. Every event emitted by a
 * daemon at this version has them.
 */

// ── Event categories ──

export const MONITOR_CATEGORIES = [
  "session",
  "work_item",
  "ci",
  "copilot",
  "review",
  "issue",
  "mail",
  "heartbeat",
  "worker",
  "daemon",
  "gc",
  "cost",
  "quota",
  "automation",
  "vfs",
] as const;

export type MonitorCategory = (typeof MONITOR_CATEGORIES)[number];

// ── Session event names ──

export const SESSION_RESULT = "session.result" as const;
export const SESSION_RESPONSE = "session.response" as const;
export const SESSION_PERMISSION_REQUEST = "session.permission_request" as const;
export const SESSION_PERMISSION_BLOCKED = "session.permission_blocked" as const;
/** The child denied a tool call itself — auto-mode classifier or a deny rule (#3119). */
export const SESSION_PERMISSION_DENIED = "session.permission_denied" as const;
/** A session asked for `auto` but could not be given `--permission-mode auto` (#3119). */
export const SESSION_PERMISSION_MODE_DOWNGRADED = "session.permission_mode_downgraded" as const;
export const SESSION_ENDED = "session.ended" as const;
export const SESSION_DISCONNECTED = "session.disconnected" as const;
export const SESSION_ERROR = "session.error" as const;
export const SESSION_CLEARED = "session.cleared" as const;
export const SESSION_MODEL_CHANGED = "session.model_changed" as const;
export const SESSION_RATE_LIMITED = "session.rate_limited" as const;
export const SESSION_CONTAINMENT_WARNING = "session.containment_warning" as const;
export const SESSION_CONTAINMENT_DENIED = "session.containment_denied" as const;
export const SESSION_CONTAINMENT_ESCALATED = "session.containment_escalated" as const;
export const SESSION_CONTAINMENT_RESET = "session.containment_reset" as const;
export const SESSION_IDLE = "session.idle" as const;
export const SESSION_STUCK = "session.stuck" as const;
export const SESSION_TOOL_USE = "session.tool_use" as const;
export const SESSION_SPAWN_OVERRIDE = "session.spawn_override" as const;
/** Which GitHub credential tier a spawn resolved to (#1510). Secret-free by construction. */
export const SESSION_GH_CREDENTIALS = "session.gh_credentials" as const;

// ── Session metric event names (#1610) ──

export const METRIC_SESSION_FOOTPRINT = "metric.session.footprint" as const;
export const METRIC_SESSION_COMMAND_HIST = "metric.session.command_hist" as const;
export const METRIC_SESSION_QUERIES = "metric.session.queries" as const;

// ── Work item event names ──

export const PR_OPENED = "pr.opened" as const;
export const PR_PUSHED = "pr.pushed" as const;
export const PR_MERGED = "pr.merged" as const;
export const PR_CLOSED = "pr.closed" as const;
export const CHECKS_STARTED = "checks.started" as const;
export const CHECKS_PASSED = "checks.passed" as const;
export const CHECKS_FAILED = "checks.failed" as const;
export const REVIEW_APPROVED = "review.approved" as const;
export const REVIEW_CHANGES_REQUESTED = "review.changes_requested" as const;
export const PHASE_CHANGED = "phase.changed" as const;
export const PR_MERGE_STATE_CHANGED = "pr.merge_state_changed" as const;
export const PR_REVIEW_COMMENT_POSTED = "pr.review_comment_posted" as const;

// ── CI run event names (#1577) ──

export const CI_STARTED = "ci.started" as const;
export const CI_RUNNING = "ci.running" as const;
export const CI_FINISHED = "ci.finished" as const;

// ── Review event names (#1579) ──

export const REVIEW_COMMENTED = "review.commented" as const;
export const PR_COMMENT = "pr.comment" as const;
export const REVIEW_STICKY_UPDATED = "review.sticky_updated" as const;

// ── Issue event names (#1579) ──

export const ISSUE_COMMENT = "issue.comment" as const;

// ── Mail event names ──

export const MAIL_SENT = "mail.sent" as const;

// ── Budget / cost event names (#1587) ──

export const COST_SESSION_OVER_BUDGET = "cost.session_over_budget" as const;
export const COST_SPRINT_OVER_BUDGET = "cost.sprint_over_budget" as const;

// ── Quota event names (#1587) ──

export const QUOTA_UTILIZATION_THRESHOLD = "quota.utilization_threshold" as const;

// ── Worker event names (#1586) ──

export const WORKER_RATELIMITED = "worker.ratelimited" as const;

// ── Daemon lifecycle event names (#1586) ──

export const DAEMON_RESTARTED = "daemon.restarted" as const;
export const DAEMON_CONFIG_RELOADED = "daemon.config_reloaded" as const;

// ── GC event names (#1586) ──

export const GC_PRUNED = "gc.pruned" as const;

// ── Automation event names (#2018) ──

export const AUTOMATION_FIRED = "automation.fired" as const;
export const AUTOMATION_SKIPPED = "automation.skipped" as const;
export const AUTOMATION_ERRORED = "automation.errored" as const;
export const AUTOMATION_ESCALATED = "automation.escalated" as const;

// ── VFS clone/pull progress event names (#1249) ──

export const VFS_STARTED = "vfs.started" as const;
export const VFS_PROGRESS = "vfs.progress" as const;
export const VFS_COMPLETED = "vfs.completed" as const;
export const VFS_FAILED = "vfs.failed" as const;

/**
 * The terminal events of a vfs operation.
 *
 * What holds: a run that reaches its own end — success or a thrown error —
 * emits exactly one of these. `ProgressReporter` latches on the first, so the
 * success and failure paths cannot both fire. That is what makes a slow clone
 * distinguishable from a crashed one, which is the defect #1249 exists to fix.
 *
 * What does **not** hold, stated plainly because `mcx monitor --until` and
 * `ctx.waitForEvent` users will otherwise write unbounded waits against it:
 *
 * - **A signal-terminated run leaves the stream open.** Ctrl-C, SIGTERM and
 *   SIGKILL all produce `vfs.started`, some `vfs.progress`, and then nothing.
 *   Ctrl-C is a likely way a long clone ends, so this is not a corner case.
 *   Handling it needs a latch shared with the reporter's, so that a signal
 *   arriving *during* the real terminal publish neither duplicates it nor
 *   suppresses it; tracked in #3154 rather than approximated here.
 * - **A terminal publish can be dropped silently.** Publishing is best-effort
 *   and bounded (`PROGRESS_PUBLISH_TIMEOUT_MS`), so a daemon that stops
 *   answering mid-publish loses the event with no error and a zero exit code.
 * - A power cut or hard runtime crash, for the obvious reason.
 *
 * So: the contract removes the need for a *routine* timeout on a waiter. It
 * does not remove the need for a backstop, and a subscriber that blocks
 * forever on one of these is relying on more than this stream promises.
 */
export const VFS_TERMINAL_EVENTS = [VFS_COMPLETED, VFS_FAILED] as const;

/** The long-running vfs operations that report progress. */
export type VfsOperation = "clone" | "pull";

/**
 * Stage of a vfs operation. `list` walks the remote index, `content` fetches
 * bodies for entries whose listing had none. Writing files is not a stage: it
 * is local `writeFileSync` calls, fast enough that nobody waits on it.
 *
 * Deliberately *not* called `phase`: the flat envelope already has a top-level
 * `phase`, the work-item phase that `mcx monitor --phase` filters on
 * (`event-filter.ts`). Two different meanings in one key is a trap for the next
 * consumer that writes `event.phase as WorkItemPhase`.
 */
export type VfsStage = "list" | "content";

/**
 * Flat payload fields carried by `vfs.*` events. Spread at the top level of the
 * envelope — see the envelope contract in the file header, the fields never nest
 * under `payload`.
 */
export interface VfsProgressFields {
  /**
   * Correlation id, constant for one clone/pull run. Two concurrent runs
   * interleave on the bus; this is how a subscriber demultiplexes them (the
   * same role `sessionId` plays for session events).
   */
  runId: string;
  operation: VfsOperation;
  /** Provider name, e.g. "confluence". */
  provider: string;
  /** Scope key, e.g. a Confluence space key. */
  scope: string;
  /**
   * Repo the operation targets — clone's target directory, pull's repo dir.
   * Required: `event-filter.ts` passes an event with no `repoRoot` through
   * every repo-scoped filter, so omitting it would spray clone chatter into
   * unrelated monitors.
   */
  repoRoot: string;
  /** Stage this update belongs to. Absent before the first tick. */
  stage?: VfsStage;
  /** Items processed so far in `stage`. */
  current: number;
  /** Total items expected, when the provider can estimate one up front. */
  total?: number;
  /** `current`/`total` as a 0-100 integer. Present only when `total` is known. */
  percent?: number;
  /** Noun for the counted items, e.g. "pages" for Confluence, "issues" for Jira. */
  unit?: string;
  /** What the run produced (pages cloned, changes applied). Terminal events only. */
  items?: number;
  /** Failure reason. `vfs.failed` only. */
  error?: string;
}

// ── Alias supervisor event names (#1924) ──

export const ALIAS_CRASHED = "alias.crashed" as const;

// ── Heartbeat ──

export const HEARTBEAT = "heartbeat" as const;

// ── Envelope ──

/** Actionability tiers, ascending. See `MONITOR_SEVERITY_RANK` for ordering. */
export const MONITOR_SEVERITIES = ["info", "notable", "actionable", "urgent"] as const;

export type MonitorSeverity = (typeof MONITOR_SEVERITIES)[number];

/** Numeric rank for threshold comparisons (`rank >= rank("actionable")`). */
export const MONITOR_SEVERITY_RANK: Record<MonitorSeverity, number> = {
  info: 0,
  notable: 1,
  actionable: 2,
  urgent: 3,
};

/**
 * Common fields for all monitor events.
 *
 * Category-specific fields go at the top level — see the envelope contract in
 * the file header. Nesting them under `payload` is a producer-side contract
 * violation and is rejected by the type.
 */
export interface MonitorEventBase {
  src: string;
  event: string;
  category: MonitorCategory;
  workItemId?: string;
  sessionId?: string;
  prNumber?: number;
  /** Producer-rendered one-liner (≤120 chars). Always present on published events. */
  summary?: string;
  /** Actionability tier. Always present on published events. */
  severity?: MonitorSeverity;
  /** Forbidden: the envelope is flat. Put category-specific fields at the top level. */
  payload?: never;
  /** Repo root path this event is scoped to. Present when known / when session is repo-scoped; absent on global events (mail, quota, heartbeats) and sessions started without a configured or discoverable repo root. */
  repoRoot?: string;
  /**
   * Domain that owns this event, as a producer hint (#3040).
   *
   * Optional on **input** because almost no producer knows its domain — they know a
   * `repoRoot`, and `EventBus.publish` turns that into a domain through the one
   * resolution rule (`resolveDomainForPath`). A producer that genuinely knows better
   * — because it was handed a domain rather than a path — sets this and publish
   * honours it. It is **required on {@link MonitorEvent}**: by the time an event is
   * published it has a domain, even if that domain is `NO_DOMAIN_ID`.
   */
  domainId?: number;
  /**
   * Name of the domain this event belongs to (`domains.name`) — the human-readable
   * counterpart to `domainId`. Present on events produced by a domain-scoped writer —
   * every `work_item.*` event carries it (#3037). Absent on genuinely global events,
   * on `NO_DOMAIN_ID`, and on rows that predate any domain (`domain_id = 0`), where
   * "unassigned" is the honest answer and a synthesized default would be a lie.
   */
  domain?: string;
  /** Causal chain of seq IDs — present on events from DerivedEventPublisher (src:"daemon.derived"). Depth is capped at 4. */
  causedBy?: number[];
  [key: string]: unknown;
}

/**
 * A **published** event: the envelope after `EventBus.publish` has stamped it.
 *
 * `domainId` is required here and optional on {@link MonitorEventBase} on purpose.
 * The partition is the point of the domain epic, and "the producer forgot to say which
 * domain" is exactly the kind of omission that reads as `domain_id = 0` forever and is
 * invisible until two projects overwrite each other. Making it required on the published
 * type means the compiler — not a review comment — stops an event from being persisted,
 * replayed or filtered without one. `NO_DOMAIN_ID` is a legitimate answer (daemon-wide
 * events genuinely have no domain); *not answering* is not.
 */
export interface MonitorEvent extends MonitorEventBase {
  seq: number;
  ts: string;
  domainId: number;
}

export type MonitorEventInput = MonitorEventBase;

// ── Projection layer (#1515) ──

const MAX_LINE = 200;

function ts(e: MonitorEvent): string {
  const d = new Date(e.ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `[${h}:${m}:${s}]`;
}

function wi(e: MonitorEventBase): string {
  return typeof e.workItemId === "string" ? e.workItemId : "";
}

function sid(e: MonitorEventBase): string {
  return typeof e.sessionId === "string" ? e.sessionId.slice(0, 8) : "";
}

function pr(e: MonitorEventBase): string {
  return typeof e.prNumber === "number" ? `PR#${e.prNumber}` : "";
}

function cost(e: MonitorEventBase): string {
  return typeof e.cost === "number" ? `$${e.cost.toFixed(2)}` : "";
}

function turns(e: MonitorEventBase): string {
  return typeof e.numTurns === "number" ? `${e.numTurns}t` : "";
}

function cap(s: string, budget: number): string {
  return s.length > budget ? `${s.slice(0, budget - 1)}…` : s;
}

function join(...parts: (string | undefined | false)[]): string {
  return parts.filter(Boolean).join("  ");
}

/**
 * Formatters run both at emit time (to render `summary`, before `seq`/`ts` are
 * stamped) and at display time, so they must tolerate a partial envelope.
 */
type FormatterInput = MonitorEventBase & Partial<Pick<MonitorEvent, "seq" | "ts">>;

type Formatter = (e: FormatterInput) => string;

const FORMATTERS: Partial<Record<string, Formatter>> = {
  [SESSION_RESULT]: (e) => {
    const raw =
      typeof e.resultPreview === "string"
        ? e.resultPreview
        : typeof e.result === "string"
          ? e.result.replace(/\n/g, " ")
          : undefined;
    const preview = typeof raw === "string" ? `  "${cap(raw, 60)}"` : "";
    return join(wi(e), sid(e), cost(e), turns(e)) + preview;
  },

  [SESSION_IDLE]: (e) => {
    const preview = typeof e.resultPreview === "string" ? `  "${cap(e.resultPreview, 60)}"` : "";
    return join(wi(e), sid(e), cost(e), turns(e)) + preview;
  },

  [SESSION_PERMISSION_REQUEST]: (e) => {
    const tool = typeof e.toolName === "string" ? e.toolName : "";
    return join(wi(e), sid(e), tool);
  },

  [SESSION_PERMISSION_BLOCKED]: (e) => {
    const tool = typeof e.toolName === "string" ? e.toolName : "";
    return join(wi(e), sid(e), tool);
  },

  [SESSION_PERMISSION_DENIED]: (e) => {
    const tool = typeof e.toolName === "string" ? e.toolName : "";
    const by = typeof e.reasonType === "string" ? `by:${e.reasonType}` : "";
    const reason = typeof e.reason === "string" ? cap(e.reason, 60) : "";
    return join(wi(e), sid(e), tool, by, reason);
  },

  [SESSION_PERMISSION_MODE_DOWNGRADED]: (e) => {
    const reason = typeof e.reason === "string" ? cap(e.reason, 80) : "";
    return join(wi(e), sid(e), "auto → default", reason);
  },

  [SESSION_ENDED]: (e) => join(wi(e), sid(e), cost(e), turns(e)),

  [SESSION_DISCONNECTED]: (e) => join(wi(e), sid(e)),

  [SESSION_ERROR]: (e) => {
    const msg = Array.isArray(e.errors) ? String(e.errors[0] ?? "") : "";
    return join(wi(e), sid(e), cap(msg, 80));
  },

  [SESSION_CLEARED]: (e) => join(wi(e), sid(e)),

  [SESSION_MODEL_CHANGED]: (e) => {
    const model = typeof e.model === "string" ? e.model : "";
    return join(wi(e), sid(e), model);
  },

  [SESSION_RATE_LIMITED]: (e) => {
    const retry = typeof e.retryAfterMs === "number" ? `retry in ${Math.round(e.retryAfterMs / 1000)}s` : "";
    return join(wi(e), sid(e), retry);
  },

  [SESSION_CONTAINMENT_WARNING]: (e) => {
    const reason = typeof e.reason === "string" ? cap(e.reason, 60) : "";
    return join(wi(e), sid(e), `strikes:${e.strikes ?? "?"}`, reason);
  },

  [SESSION_STUCK]: (e) => {
    const tier = typeof e.tier === "number" ? `tier:${e.tier}` : "";
    const since = typeof e.sinceMs === "number" ? `${Math.round(e.sinceMs / 1000)}s` : "";
    const tool = typeof e.lastTool === "string" ? e.lastTool : "";
    const err = typeof e.lastToolError === "string" ? cap(e.lastToolError, 40) : "";
    return join(wi(e), sid(e), tier, since, tool, err);
  },

  [SESSION_CONTAINMENT_DENIED]: (e) => {
    const reason = typeof e.reason === "string" ? cap(e.reason, 60) : "";
    return join(wi(e), sid(e), reason);
  },

  [SESSION_CONTAINMENT_ESCALATED]: (e) => join(wi(e), sid(e)),

  [SESSION_SPAWN_OVERRIDE]: (e) => {
    const binary = typeof e.binaryPath === "string" ? cap(e.binaryPath, 60) : "";
    const bypassed = typeof e.bypassedReason === "string" ? `bypassed: ${cap(e.bypassedReason, 60)}` : "";
    // Spawn-profile NAME and source only (#935) — never a key, never a value.
    // Without this the event reached `monitor_events` but `mcx monitor` rendered
    // a bare sid with empty columns, so the one record of which credentials a
    // session ran under was invisible in the view built to show it.
    const profile = typeof e.profile === "string" ? `profile: ${cap(e.profile, 64)}` : "";
    const source = typeof e.profileSource === "string" ? `(${cap(e.profileSource, 16)})` : "";
    return join(wi(e), sid(e), binary, bypassed, profile, source);
  },

  [SESSION_GH_CREDENTIALS]: (e) => {
    const mode = typeof e.mode === "string" ? e.mode : "";
    // `problem` is the operator-actionable half when a tokens file was rejected;
    // it names a path and a mode, never token material.
    const detail = typeof e.problem === "string" ? e.problem : typeof e.reason === "string" ? e.reason : "";
    return join(wi(e), sid(e), mode, cap(detail, 80));
  },

  [PR_OPENED]: (e) => {
    const branch = typeof e.branch === "string" ? e.branch : "";
    const base = typeof e.base === "string" ? e.base : "";
    const commits = typeof e.commits === "number" ? `${e.commits}c` : "";
    const churn = typeof e.srcChurn === "number" ? `churn:${e.srcChurn}${e.filesTruncated ? "+" : ""}` : "";
    return join(wi(e), pr(e), branch && base ? `${branch}→${base}` : branch || base, commits, churn);
  },

  [PR_PUSHED]: (e) => {
    const branch = typeof e.branch === "string" ? e.branch : "";
    const commits = typeof e.commits === "number" ? `${e.commits}c` : "";
    const churn = typeof e.srcChurn === "number" ? `churn:${e.srcChurn}${e.filesTruncated ? "+" : ""}` : "";
    return join(wi(e), pr(e), branch, commits, churn);
  },

  [PR_MERGED]: (e) => {
    const sha = typeof e.mergeSha === "string" ? e.mergeSha.slice(0, 8) : "";
    return join(wi(e), pr(e), sha);
  },

  [PR_CLOSED]: (e) => join(wi(e), pr(e)),

  [CHECKS_STARTED]: (e) => join(wi(e), pr(e)),

  [CHECKS_PASSED]: (e) => join(wi(e), pr(e)),

  [CHECKS_FAILED]: (e) => {
    const job = typeof e.failedJob === "string" ? e.failedJob : "";
    return join(wi(e), pr(e), job);
  },

  [REVIEW_APPROVED]: (e) => {
    const reviewer = typeof e.reviewer === "string" ? e.reviewer : "";
    return join(wi(e), pr(e), reviewer);
  },

  [REVIEW_CHANGES_REQUESTED]: (e) => {
    const reviewer = typeof e.reviewer === "string" ? e.reviewer : "";
    return join(wi(e), pr(e), reviewer);
  },

  [PHASE_CHANGED]: (e) => {
    const from = typeof e.from === "string" ? e.from : "";
    const to = typeof e.to === "string" ? e.to : "";
    return join(wi(e), from && to ? `${from} → ${to}` : from || to);
  },

  [CI_STARTED]: (e) => {
    const checks = Array.isArray(e.checks) ? (e.checks as string[]).join(", ") : "";
    return join(wi(e), pr(e), checks);
  },

  [CI_RUNNING]: (e) => {
    const inProgress = Array.isArray(e.inProgress) ? (e.inProgress as string[]).join(", ") : "";
    return join(wi(e), pr(e), inProgress && `running: ${inProgress}`);
  },

  [CI_FINISHED]: (e) => {
    const green = e.allGreen === true ? "✓ all green" : "✗ failed";
    const dur =
      typeof e.observedDurationMs === "number" ? `${Math.round((e.observedDurationMs as number) / 1000)}s` : "";
    return join(wi(e), pr(e), green, dur);
  },

  [PR_MERGE_STATE_CHANGED]: (e) => {
    const from = typeof e.from === "string" ? e.from : "?";
    const to = typeof e.to === "string" ? e.to : "?";
    const head = typeof e.cascadeHead === "number" ? `cascade:#${e.cascadeHead}` : "";
    return join(wi(e), pr(e), `${from} → ${to}`, head);
  },

  [PR_REVIEW_COMMENT_POSTED]: (e) => {
    const author = typeof e.author === "string" ? e.author : "";
    const count = typeof e.newCount === "number" ? `${e.newCount} comment${e.newCount === 1 ? "" : "s"}` : "";
    const first = typeof e.firstLine === "string" ? e.firstLine : "";
    return join(wi(e), pr(e), author, count, first);
  },

  [REVIEW_COMMENTED]: (e) => {
    const author = typeof e.author === "string" ? e.author : "";
    return join(wi(e), pr(e), author);
  },

  [PR_COMMENT]: (e) => {
    const author = typeof e.author === "string" ? e.author : "";
    return join(wi(e), pr(e), author);
  },

  [REVIEW_STICKY_UPDATED]: (e) => {
    const author = typeof e.author === "string" ? e.author : "";
    const hash = typeof e.bodyHash === "string" ? e.bodyHash.slice(0, 8) : "";
    return join(wi(e), pr(e), author, hash);
  },

  [ISSUE_COMMENT]: (e) => {
    const author = typeof e.author === "string" ? e.author : "";
    return join(wi(e), author);
  },

  [MAIL_SENT]: (e) => {
    const sender = typeof e.sender === "string" ? e.sender : "";
    const recipient = typeof e.recipient === "string" ? e.recipient : "";
    return join(sender, "→", recipient);
  },

  [SESSION_TOOL_USE]: (e) => {
    const tool = typeof e.toolName === "string" ? e.toolName : "";
    const fp = typeof e.filePath === "string" ? cap(e.filePath, 40) : "";
    return join(sid(e), tool, fp);
  },

  [METRIC_SESSION_FOOTPRINT]: (e) => {
    const dirs = Array.isArray(e.footprint) ? (e.footprint as unknown[]).length : 0;
    const ratio = typeof e.readWriteRatio === "number" ? `rw:${e.readWriteRatio}` : "";
    return join(sid(e), `${dirs} dir(s)`, ratio);
  },

  [METRIC_SESSION_COMMAND_HIST]: (e) => {
    const cmds = Array.isArray(e.commands) ? (e.commands as unknown[]).length : 0;
    return join(sid(e), `${cmds} command(s)`);
  },

  [METRIC_SESSION_QUERIES]: (e) => {
    const n = Array.isArray(e.recent) ? (e.recent as unknown[]).length : 0;
    return join(sid(e), `${n} recent query(ies)`);
  },

  [COST_SESSION_OVER_BUDGET]: (e) => {
    const limit = typeof e.limit === "number" ? `limit:$${e.limit.toFixed(2)}` : "";
    return join(wi(e), sid(e), cost(e), limit);
  },

  [COST_SPRINT_OVER_BUDGET]: (e) => {
    const total = typeof e.totalCost === "number" ? `$${(e.totalCost as number).toFixed(2)}` : "";
    const limit = typeof e.limit === "number" ? `limit:$${e.limit.toFixed(2)}` : "";
    const sessions = typeof e.sessionCount === "number" ? `${e.sessionCount} sessions` : "";
    return join(total, limit, sessions);
  },

  [QUOTA_UTILIZATION_THRESHOLD]: (e) => {
    const util = typeof e.utilization === "number" ? `${e.utilization.toFixed(0)}%` : "";
    const thresh = typeof e.threshold === "number" ? `threshold:${e.threshold}%` : "";
    const provider = typeof e.provider === "string" ? e.provider : "";
    return join(provider, util, thresh);
  },

  [WORKER_RATELIMITED]: (e) => {
    const retry = typeof e.retryAfterMs === "number" ? `retry in ${Math.round(e.retryAfterMs / 1000)}s` : "";
    const provider = typeof e.provider === "string" ? e.provider : "";
    return join(sid(e), provider, retry);
  },

  [DAEMON_RESTARTED]: (e) => {
    const reason = typeof e.reason === "string" ? e.reason : "";
    const before = typeof e.seqBefore === "number" ? `seq:${e.seqBefore}` : "";
    const seqAfter = typeof e.seqAfter === "number" ? e.seqAfter : e.seq;
    const after = typeof seqAfter === "number" ? `→${seqAfter}` : "";
    return join(reason, before + after);
  },

  [DAEMON_CONFIG_RELOADED]: (e) => {
    const keys = Array.isArray(e.changedKeys) ? (e.changedKeys as string[]).join(", ") : "";
    const path = typeof e.path === "string" ? e.path : "";
    return join(path && cap(path, 40), keys && `keys: ${keys}`);
  },

  [GC_PRUNED]: (e) => {
    const wt = Array.isArray(e.worktrees) ? `${(e.worktrees as string[]).length}wt` : "";
    const br = Array.isArray(e.branches) ? `${(e.branches as string[]).length}br` : "";
    const reason = typeof e.reason === "string" ? e.reason : "";
    return join(wt, br, reason);
  },

  [AUTOMATION_FIRED]: (e) => {
    const mod = typeof e.module === "string" ? e.module : "";
    const act = typeof e.actionType === "string" ? e.actionType : "";
    const dur = typeof e.durationMs === "number" ? `${e.durationMs}ms` : "";
    return join(wi(e), mod, act, dur);
  },

  [AUTOMATION_SKIPPED]: (e) => {
    const mod = typeof e.module === "string" ? e.module : "";
    const reason = typeof e.reason === "string" ? cap(e.reason, 60) : "";
    return join(wi(e), mod, reason);
  },

  [AUTOMATION_ERRORED]: (e) => {
    const mod = typeof e.module === "string" ? e.module : "";
    const err = typeof e.error === "string" ? cap(e.error, 60) : "";
    return join(wi(e), mod, err);
  },

  [AUTOMATION_ESCALATED]: (e) => {
    const mod = typeof e.module === "string" ? e.module : "";
    const reason = typeof e.reason === "string" ? cap(e.reason, 60) : "";
    return join(wi(e), mod, reason);
  },

  [VFS_STARTED]: (e) => join(vfsTarget(e), vfsCount(e)),

  [VFS_PROGRESS]: (e) => {
    const stage = typeof e.stage === "string" ? e.stage : "";
    return join(vfsTarget(e), stage, vfsCount(e));
  },

  [VFS_COMPLETED]: (e) => join(vfsTarget(e), vfsCount(e)),

  [VFS_FAILED]: (e) => join(vfsTarget(e), vfsCount(e), typeof e.error === "string" ? e.error : "failed"),

  [HEARTBEAT]: (e) => `seq:${e.seq}`,
};

/** `clone confluence/FOO` — which operation is running against which scope. */
function vfsTarget(e: MonitorEventBase): string {
  const op = typeof e.operation === "string" ? e.operation : "vfs";
  const provider = typeof e.provider === "string" ? e.provider : "";
  const scope = typeof e.scope === "string" ? e.scope : "";
  return join(op, provider && scope ? `${provider}/${scope}` : provider || scope);
}

/** `250/5000 pages (5%)`, degrading to `250 pages` when no total could be estimated. */
function vfsCount(e: MonitorEventBase): string {
  if (typeof e.current !== "number") return "";
  const unit = typeof e.unit === "string" && e.unit ? ` ${e.unit}` : "";
  const total = typeof e.total === "number" ? e.total : undefined;
  if (total === undefined) return `${e.current}${unit}`;
  const pct = typeof e.percent === "number" ? ` (${e.percent}%)` : "";
  return `${e.current}/${total}${unit}${pct}`;
}

/**
 * Format a MonitorEvent as a human-readable one-liner (≤200 chars).
 *
 * Format: `[HH:MM:SS] event.type  <context fields>`
 *
 * For event types without a formatter, uses the producer-rendered `summary`
 * when present, else a generic field dump.
 */
export function formatMonitorEvent(e: MonitorEvent): string {
  const formatter = FORMATTERS[e.event];
  const label = e.event === HEARTBEAT ? "♥ heartbeat    " : e.event.padEnd(24);
  const detail = formatter ? formatter(e) : typeof e.summary === "string" && e.summary ? e.summary : fallback(e);
  const line = `${ts(e)} ${label}  ${detail}`;
  return cap(line, MAX_LINE);
}

// ── Producer-owned envelope fields (#1924) ──

const MAX_SUMMARY = 120;

/**
 * Render the one-line `summary` for an event, from the same per-type formatters
 * used by `formatMonitorEvent`. Never returns an empty string — events with no
 * contextual fields summarize to their event name.
 */
export function summarizeMonitorEvent(e: FormatterInput): string {
  if (e.event === HEARTBEAT) return typeof e.seq === "number" ? `heartbeat seq:${e.seq}` : "heartbeat";
  const formatter = FORMATTERS[e.event];
  const detail = normalizeSummary(formatter ? formatter(e) : fallback(e));
  return detail || normalizeSummary(e.event) || e.event || "(unnamed event)";
}

/**
 * Baseline severity per event type. Unmapped types default to `info`.
 * Value-dependent tiers are refined by SEVERITY_OVERRIDES below.
 */
const SEVERITY_BY_EVENT: Partial<Record<string, MonitorSeverity>> = {
  // urgent — a human/orchestrator decision is blocking progress or money is burning
  [SESSION_PERMISSION_REQUEST]: "urgent",
  [SESSION_PERMISSION_BLOCKED]: "urgent",
  [COST_SESSION_OVER_BUDGET]: "urgent",
  [COST_SPRINT_OVER_BUDGET]: "urgent",
  [WORKER_RATELIMITED]: "urgent",
  [DAEMON_RESTARTED]: "urgent",
  [SESSION_CONTAINMENT_ESCALATED]: "urgent",

  // actionable — the orchestrator has work to do in response
  [SESSION_IDLE]: "actionable",
  [SESSION_RESULT]: "actionable",
  [SESSION_STUCK]: "actionable",
  [SESSION_ERROR]: "actionable",
  [SESSION_DISCONNECTED]: "actionable",
  [SESSION_ENDED]: "actionable",
  [SESSION_RATE_LIMITED]: "actionable",
  [SESSION_CONTAINMENT_DENIED]: "actionable",
  // A denial the daemon didn't make and can't answer: the worker keeps running
  // with a capability it silently lacks, so someone has to look (#3119).
  [SESSION_PERMISSION_DENIED]: "actionable",
  [SESSION_PERMISSION_MODE_DOWNGRADED]: "notable",
  [ALIAS_CRASHED]: "actionable",
  [PR_MERGED]: "actionable",
  [PR_CLOSED]: "actionable",
  [CI_FINISHED]: "actionable",
  [CHECKS_FAILED]: "actionable",
  [PHASE_CHANGED]: "actionable",
  [GC_PRUNED]: "actionable",
  [AUTOMATION_ERRORED]: "actionable",
  [AUTOMATION_ESCALATED]: "actionable",
  [VFS_FAILED]: "actionable",

  // notable — state moved, but nothing to do yet
  [PR_OPENED]: "notable",
  [PR_PUSHED]: "notable",
  [CI_STARTED]: "notable",
  [CI_RUNNING]: "notable",
  [CHECKS_STARTED]: "notable",
  [CHECKS_PASSED]: "notable",
  [REVIEW_APPROVED]: "notable",
  [REVIEW_CHANGES_REQUESTED]: "notable",
  [REVIEW_COMMENTED]: "notable",
  [REVIEW_STICKY_UPDATED]: "notable",
  [PR_COMMENT]: "notable",
  [ISSUE_COMMENT]: "notable",
  [DAEMON_CONFIG_RELOADED]: "notable",
  [SESSION_CONTAINMENT_WARNING]: "notable",
  [SESSION_CONTAINMENT_RESET]: "notable",
  [SESSION_MODEL_CHANGED]: "notable",
  [SESSION_CLEARED]: "notable",
  [SESSION_SPAWN_OVERRIDE]: "notable",
  [AUTOMATION_FIRED]: "notable",
  [AUTOMATION_SKIPPED]: "notable",
  [VFS_COMPLETED]: "notable",

  // info — telemetry / chatter (also the default for unmapped types)
  [HEARTBEAT]: "info",
  [VFS_STARTED]: "info",
  [VFS_PROGRESS]: "info",
  [SESSION_TOOL_USE]: "info",
  [SESSION_RESPONSE]: "info",
  [MAIL_SENT]: "info",
  [METRIC_SESSION_FOOTPRINT]: "info",
  [METRIC_SESSION_COMMAND_HIST]: "info",
  [METRIC_SESSION_QUERIES]: "info",
};

/** Value-dependent severity: the same event type can be chatter or a call to action. */
const SEVERITY_OVERRIDES: Partial<Record<string, (e: MonitorEventBase) => MonitorSeverity>> = {
  // A BEHIND PR with a known cascade head is the orchestrator's cue to update-branch.
  [PR_MERGE_STATE_CHANGED]: (e) => (typeof e.cascadeHead === "number" ? "actionable" : "notable"),
  [QUOTA_UTILIZATION_THRESHOLD]: (e) =>
    typeof e.utilization === "number" && e.utilization >= 95 ? "urgent" : "notable",
  [PR_REVIEW_COMMENT_POSTED]: (e) => (typeof e.newCount === "number" && e.newCount > 0 ? "actionable" : "notable"),
  // A rejected tokens file silently costs every spawn its GitHub access, so it
  // is actionable; a routine `scoped`/`inherited` decision is a record, not news.
  [SESSION_GH_CREDENTIALS]: (e) => (typeof e.problem === "string" ? "actionable" : "info"),
};

/** Classify an event's actionability. Unmapped event types are `info`. */
export function severityForMonitorEvent(e: MonitorEventBase): MonitorSeverity {
  const override = SEVERITY_OVERRIDES[e.event];
  if (override) return override(e);
  return SEVERITY_BY_EVENT[e.event] ?? "info";
}

const SEVERITY_SET: ReadonlySet<string> = new Set(MONITOR_SEVERITIES);

/** True when `event` has an explicit tier rather than falling through to the `info` default. */
export function hasExplicitSeverity(event: string): boolean {
  return event in SEVERITY_BY_EVENT || event in SEVERITY_OVERRIDES;
}

/**
 * Normalize an event onto the envelope contract. This is the single enforcement
 * point for all three invariants, because the two untyped ingress paths
 * (`publishEvent` IPC `extra`, automation `emit-event`) spread caller-supplied
 * keys straight into `publish` and the compiler cannot see them:
 *
 * - **`payload` is dropped.** The envelope is flat; a nested payload never
 *   reaches a consumer even if a caller supplies one.
 * - **`severity` is validated** against `MONITOR_SEVERITIES`. A missing or
 *   out-of-set value falls back to the classification table, so the field is
 *   always one of the four tiers.
 * - **`summary` is re-normalized** — newlines collapsed, trimmed, capped at 120
 *   chars — whether it came from a producer or from the formatters. Never empty.
 */
export function enrichMonitorEvent<T extends FormatterInput>(e: T): T & { summary: string; severity: MonitorSeverity } {
  const { payload: _payload, ...rest } = e;
  try {
    const producerSummary = typeof e.summary === "string" ? normalizeSummary(e.summary) : "";
    const summary = producerSummary || summarizeMonitorEvent(e);
    const severity =
      typeof e.severity === "string" && SEVERITY_SET.has(e.severity)
        ? (e.severity as MonitorSeverity)
        : severityForMonitorEvent(e);
    return { ...rest, summary, severity } as T & { summary: string; severity: MonitorSeverity };
  } catch (err) {
    // Never throw: `publish` calls this before its own error containment, and
    // some callers (derived-events) publish after committing their cursor, so a
    // throw here would drop the event permanently. Degrade to the event name
    // plus the static tier — rendering is best-effort, delivery is not.
    console.error(`[monitor-event] enrich failed for "${e.event}", degrading:`, err);
    return {
      ...rest,
      summary: typeof e.event === "string" && e.event ? cap(e.event, MAX_SUMMARY) : "(unnamed event)",
      severity: SEVERITY_BY_EVENT[e.event] ?? "info",
    } as T & { summary: string; severity: MonitorSeverity };
  }
}

function normalizeSummary(s: string): string {
  return cap(s.replace(/\s*[\r\n]+\s*/g, " ").trim(), MAX_SUMMARY);
}

function fallback(e: FormatterInput): string {
  const fields = Object.entries(e)
    .filter(([k]) => !["seq", "ts", "src", "event", "category", "summary", "severity"].includes(k))
    .slice(0, 4)
    .map(([k, v]) => `${k}:${String(v).slice(0, 20)}`);
  return fields.join("  ");
}
