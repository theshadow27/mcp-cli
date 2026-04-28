import type { Database } from "bun:sqlite";
import type { MonitorEvent, MonitorEventInput } from "@mcp-cli/core";
import {
  METRIC_SESSION_COMMAND_HIST,
  METRIC_SESSION_FOOTPRINT,
  METRIC_SESSION_QUERIES,
  SESSION_DISCONNECTED,
  SESSION_ENDED,
  SESSION_IDLE,
  SESSION_PERMISSION_REQUEST,
  SESSION_RESULT,
  SESSION_TOOL_USE,
} from "@mcp-cli/core";
import type { EventBus } from "./event-bus";

// ── Aggregator state types ──

export interface DirFootprintEntry {
  dir: string;
  read: number;
  wrote: number;
  files: number;
}

export interface CommandEntry {
  cmd: string;
  runs: number;
}

export interface QueryEntry {
  tool: string;
  pattern: string;
  path?: string;
}

export interface FileReadDepthEntry {
  filePath: string;
  readCount: number;
  linesReadTotal: number;
  maxLines: number;
}

interface DirAccum {
  read: number;
  wrote: number;
  fileSet: Set<string>;
}

interface ReadDepthAccum {
  readCount: number;
  linesReadTotal: number;
  maxLines: number;
}

export interface SessionMetricState {
  sessionId: string;
  dirFootprint: Map<string, DirAccum>;
  commandHist: Map<string, number>;
  queries: QueryEntry[];
  readDepth: Map<string, ReadDepthAccum>;
  currentState: { state: string; enteredAt: number };
  stateAccum: Map<string, number>;
  hasToolCalls: boolean;
}

// ── Serialization types (for DB persistence) ──

interface SerializedState {
  dirFootprint: Array<{ dir: string; read: number; wrote: number; files: string[] }>;
  commandHist: Array<{ cmd: string; runs: number }>;
  queries: QueryEntry[];
  readDepth: Array<{ filePath: string; readCount: number; linesReadTotal: number; maxLines: number }>;
  stateAccum: Record<string, number>;
  hasToolCalls: boolean;
}

// ── Matched events ──

const MATCHED_EVENTS: ReadonlySet<string> = new Set([
  SESSION_TOOL_USE,
  SESSION_RESULT,
  SESSION_IDLE,
  SESSION_ENDED,
  SESSION_DISCONNECTED,
  SESSION_PERMISSION_REQUEST,
]);

function isRelevantEvent(event: MonitorEvent): boolean {
  return event.category === "session" && MATCHED_EVENTS.has(event.event);
}

// ── Aggregator ──

export interface SessionMetricsAggregatorOpts {
  bus: EventBus;
  db: Database;
  maxQueries?: number;
  maxPaths?: number;
  coalesceWindowMs?: number;
  pruneAfterDays?: number;
}

const DEFAULT_MAX_QUERIES = 20;
const DEFAULT_MAX_PATHS = 1000;
const DEFAULT_COALESCE_WINDOW_MS = 500;
const DEFAULT_PRUNE_AFTER_DAYS = 30;

export class SessionMetricsAggregator {
  private readonly bus: EventBus;
  private readonly db: Database;
  private readonly maxQueries: number;
  private readonly maxPaths: number;
  private readonly coalesceWindowMs: number;
  private readonly sessions = new Map<string, SessionMetricState>();
  private readonly subId: number;
  private disposed = false;

  private readonly saveStmt: ReturnType<Database["prepare"]>;
  private readonly loadStmt: ReturnType<Database["prepare"]>;
  private readonly pruneStmt: ReturnType<Database["prepare"]>;

  constructor(opts: SessionMetricsAggregatorOpts) {
    this.bus = opts.bus;
    this.db = opts.db;
    this.maxQueries = opts.maxQueries ?? DEFAULT_MAX_QUERIES;
    this.maxPaths = opts.maxPaths ?? DEFAULT_MAX_PATHS;
    this.coalesceWindowMs = opts.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;

    this.saveStmt = this.db.prepare(
      "INSERT OR REPLACE INTO session_metrics (session_id, metrics_json, updated_at) VALUES (?, ?, unixepoch())",
    );
    this.loadStmt = this.db.prepare("SELECT metrics_json FROM session_metrics WHERE session_id = ?");
    this.pruneStmt = this.db.prepare("DELETE FROM session_metrics WHERE updated_at < unixepoch() - ?");

    const pruneAfterDays = opts.pruneAfterDays ?? DEFAULT_PRUNE_AFTER_DAYS;
    try {
      this.pruneStmt.run(pruneAfterDays * 86400);
    } catch {
      // best-effort cleanup — don't block startup
    }

    this.subId = this.bus.subscribe((event) => this.handleEvent(event), isRelevantEvent);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bus.unsubscribe(this.subId);
    for (const [sessionId, state] of this.sessions) {
      this.persistSession(sessionId, state);
    }
    this.sessions.clear();
  }

  getState(sessionId: string): SessionMetricState | undefined {
    return this.sessions.get(sessionId);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  // ── Event dispatch ──

  private handleEvent(event: MonitorEvent): void {
    if (this.disposed) return;
    const sessionId = event.sessionId as string | undefined;
    if (!sessionId) return;

    switch (event.event) {
      case SESSION_TOOL_USE:
        this.handleToolUse(sessionId, event);
        break;
      case SESSION_RESULT:
      case SESSION_IDLE:
        this.handleStateTransition(sessionId, "idle");
        break;
      case SESSION_PERMISSION_REQUEST:
        this.handleStateTransition(sessionId, "waiting_permission");
        break;
      case SESSION_ENDED:
      case SESSION_DISCONNECTED:
        this.handleSessionEnd(sessionId);
        break;
    }
  }

  // ── Tool-use aggregation ──

  private handleToolUse(sessionId: string, event: MonitorEvent): void {
    const state = this.getOrCreate(sessionId);
    state.hasToolCalls = true;

    this.accumulateStateTime(state);
    state.currentState = { state: "active", enteredAt: Date.now() };

    const toolName = event.toolName as string;
    const dirPath = event.dirPath as string | undefined;
    const filePath = event.filePath as string | undefined;
    const linesHint = (event.linesHint as number) ?? 0;
    const isWrite = event.isWrite === true;

    if (dirPath) {
      let entry = state.dirFootprint.get(dirPath);
      if (!entry) {
        if (state.dirFootprint.size >= this.maxPaths) {
          evictOldest(state.dirFootprint);
        }
        entry = { read: 0, wrote: 0, fileSet: new Set() };
        state.dirFootprint.set(dirPath, entry);
      }
      if (isWrite) {
        entry.wrote += linesHint;
      } else {
        entry.read += linesHint;
      }
      if (filePath) entry.fileSet.add(filePath);
    }

    if (typeof event.cmdGroup === "string") {
      const cmdGroup = event.cmdGroup as string;
      state.commandHist.set(cmdGroup, (state.commandHist.get(cmdGroup) ?? 0) + 1);
    }

    if ((toolName === "Grep" || toolName === "Glob") && typeof event.pattern === "string") {
      state.queries.push({
        tool: toolName,
        pattern: event.pattern as string,
        path: event.searchPath as string | undefined,
      });
      if (state.queries.length > this.maxQueries) {
        state.queries = state.queries.slice(-this.maxQueries);
      }
    }

    if (filePath && !isWrite) {
      let rd = state.readDepth.get(filePath);
      if (!rd) {
        if (state.readDepth.size >= this.maxPaths) {
          evictOldest(state.readDepth);
        }
        rd = { readCount: 0, linesReadTotal: 0, maxLines: 0 };
        state.readDepth.set(filePath, rd);
      }
      rd.readCount++;
      rd.linesReadTotal += linesHint;
      rd.maxLines = Math.max(rd.maxLines, linesHint);
    }

    this.emitFootprint(sessionId, state);
    this.emitCommandHist(sessionId, state);
    this.emitQueries(sessionId, state);
  }

  // ── State timing ──

  private handleStateTransition(sessionId: string, newState: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.accumulateStateTime(state);
    state.currentState = { state: newState, enteredAt: Date.now() };
  }

  private accumulateStateTime(state: SessionMetricState): void {
    const elapsed = Date.now() - state.currentState.enteredAt;
    if (elapsed > 0) {
      const prev = state.stateAccum.get(state.currentState.state) ?? 0;
      state.stateAccum.set(state.currentState.state, prev + elapsed);
    }
  }

  // ── Session end ──

  private handleSessionEnd(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.accumulateStateTime(state);
    this.emitAllMetrics(sessionId, state);
    this.flushCoalesced(sessionId);
    if (this.persistSession(sessionId, state)) {
      this.sessions.delete(sessionId);
    }
  }

  // ── Metric emission (coalesced) ──

  private emitFootprint(sessionId: string, state: SessionMetricState): void {
    const footprint: DirFootprintEntry[] = [];
    for (const [dir, data] of state.dirFootprint) {
      footprint.push({ dir, read: data.read, wrote: data.wrote, files: data.fileSet.size });
    }
    if (footprint.length === 0) return;

    const totalRead = footprint.reduce((s, f) => s + f.read, 0);
    const totalWrote = footprint.reduce((s, f) => s + f.wrote, 0);

    this.bus.publishCoalesced(
      {
        src: "daemon.metric",
        event: METRIC_SESSION_FOOTPRINT,
        category: "session",
        sessionId,
        footprint,
        readWriteRatio: totalWrote > 0 ? +(totalRead / totalWrote).toFixed(2) : null,
      } satisfies MonitorEventInput,
      `metric:${sessionId}:footprint`,
      { mode: "last-wins", windowMs: this.coalesceWindowMs },
    );
  }

  private emitCommandHist(sessionId: string, state: SessionMetricState): void {
    if (state.commandHist.size === 0) return;
    const commands: CommandEntry[] = [];
    for (const [cmd, runs] of state.commandHist) {
      commands.push({ cmd, runs });
    }

    this.bus.publishCoalesced(
      {
        src: "daemon.metric",
        event: METRIC_SESSION_COMMAND_HIST,
        category: "session",
        sessionId,
        commands,
      } satisfies MonitorEventInput,
      `metric:${sessionId}:commands`,
      { mode: "last-wins", windowMs: this.coalesceWindowMs },
    );
  }

  private emitQueries(sessionId: string, state: SessionMetricState): void {
    if (state.queries.length === 0) return;

    this.bus.publishCoalesced(
      {
        src: "daemon.metric",
        event: METRIC_SESSION_QUERIES,
        category: "session",
        sessionId,
        recent: state.queries,
      } satisfies MonitorEventInput,
      `metric:${sessionId}:queries`,
      { mode: "last-wins", windowMs: this.coalesceWindowMs },
    );
  }

  private emitAllMetrics(sessionId: string, state: SessionMetricState): void {
    this.emitFootprint(sessionId, state);
    this.emitCommandHist(sessionId, state);
    this.emitQueries(sessionId, state);
  }

  private flushCoalesced(sessionId: string): void {
    this.bus.flushCoalesced(`metric:${sessionId}:footprint`);
    this.bus.flushCoalesced(`metric:${sessionId}:commands`);
    this.bus.flushCoalesced(`metric:${sessionId}:queries`);
  }

  // ── State management ──

  private getOrCreate(sessionId: string): SessionMetricState {
    let state = this.sessions.get(sessionId);
    if (state) return state;

    state = this.tryLoadFromDb(sessionId) ?? createFreshState(sessionId);
    this.sessions.set(sessionId, state);
    return state;
  }

  // ── Persistence ──

  private persistSession(sessionId: string, state: SessionMetricState): boolean {
    if (!state.hasToolCalls) return true;
    try {
      this.saveStmt.run(sessionId, serializeState(state));
      return true;
    } catch (err) {
      console.error(`[SessionMetrics] Failed to persist metrics for ${sessionId}:`, err);
      return false;
    }
  }

  private tryLoadFromDb(sessionId: string): SessionMetricState | null {
    try {
      const row = this.loadStmt.get(sessionId) as { metrics_json: string } | null;
      if (!row) return null;
      const saved = JSON.parse(row.metrics_json) as SerializedState;
      return deserializeState(sessionId, saved);
    } catch {
      return null;
    }
  }
}

// ── Pure helpers ──

function evictOldest<V>(map: Map<string, V>): void {
  const first = map.keys().next();
  if (!first.done) map.delete(first.value);
}

export function createFreshState(sessionId: string): SessionMetricState {
  return {
    sessionId,
    dirFootprint: new Map(),
    commandHist: new Map(),
    queries: [],
    readDepth: new Map(),
    currentState: { state: "active", enteredAt: Date.now() },
    stateAccum: new Map(),
    hasToolCalls: false,
  };
}

export function serializeState(state: SessionMetricState): string {
  const obj: SerializedState = {
    dirFootprint: Array.from(state.dirFootprint.entries()).map(([dir, d]) => ({
      dir,
      read: d.read,
      wrote: d.wrote,
      files: Array.from(d.fileSet),
    })),
    commandHist: Array.from(state.commandHist.entries()).map(([cmd, runs]) => ({
      cmd,
      runs,
    })),
    queries: state.queries,
    readDepth: Array.from(state.readDepth.entries()).map(([filePath, d]) => ({
      filePath,
      readCount: d.readCount,
      linesReadTotal: d.linesReadTotal,
      maxLines: d.maxLines,
    })),
    stateAccum: Object.fromEntries(state.stateAccum),
    hasToolCalls: state.hasToolCalls,
  };
  return JSON.stringify(obj);
}

export function deserializeState(sessionId: string, saved: SerializedState): SessionMetricState {
  const state = createFreshState(sessionId);
  state.hasToolCalls = saved.hasToolCalls;

  for (const entry of saved.dirFootprint) {
    state.dirFootprint.set(entry.dir, {
      read: entry.read,
      wrote: entry.wrote,
      fileSet: new Set(entry.files),
    });
  }
  for (const entry of saved.commandHist) {
    state.commandHist.set(entry.cmd, entry.runs);
  }
  state.queries = saved.queries ?? [];
  for (const entry of saved.readDepth) {
    state.readDepth.set(entry.filePath, {
      readCount: entry.readCount,
      linesReadTotal: entry.linesReadTotal,
      maxLines: entry.maxLines,
    });
  }
  if (saved.stateAccum) {
    for (const [k, v] of Object.entries(saved.stateAccum)) {
      state.stateAccum.set(k, v);
    }
  }
  return state;
}
