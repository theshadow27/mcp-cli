/**
 * Maps Codex v2 notifications to AgentSessionEvent.
 *
 * Only 8 of the ~43 ServerNotification variants are processed.
 * Legacy `codex/event/*` messages are filtered out entirely.
 */

import type { AgentPermissionRequest, AgentResult, AgentSessionEvent } from "@mcp-cli/core";
import type {
  AgentMessageDeltaParams,
  CommandExecutionApprovalParams,
  FileChangeApprovalParams,
  ThreadItem,
  ThreadItemCompletedParams,
  ThreadItemStartedParams,
  ThreadStatusChangedParams,
  TokenUsageUpdatedParams,
  TurnCompletedParams,
  TurnDiffUpdatedParams,
} from "./schemas";

/** Accumulated state needed across events within a turn. */
export interface EventMapState {
  /** Track itemId → file paths for fileChange approval correlation. */
  itemFiles: Map<string, string[]>;
  /** Track itemId → command for commandExecution items. */
  itemCommands: Map<string, string>;
  /** Current turn diff. */
  currentDiff: string | null;
  /** Cumulative token counts. */
  totalTokens: number;
  /** Reasoning tokens. */
  reasoningTokens: number;
  /** Turn count. */
  numTurns: number;
  /** Latest result text. */
  lastResultText: string;
}

export function createEventMapState(): EventMapState {
  return {
    itemFiles: new Map(),
    itemCommands: new Map(),
    currentDiff: null,
    totalTokens: 0,
    reasoningTokens: 0,
    numTurns: 0,
    lastResultText: "",
  };
}

/** Returns true if this is a legacy event that should be skipped. */
export function isLegacyEvent(method: string): boolean {
  return method.startsWith("codex/event/");
}

/**
 * Map a v2 notification to zero or more AgentSessionEvents.
 *
 * Returns an empty array for unhandled notifications.
 */
export function mapNotification(
  method: string,
  params: Record<string, unknown>,
  state: EventMapState,
  sessionId: string,
  provider: "codex",
): AgentSessionEvent[] {
  switch (method) {
    case "thread/started":
      return [];

    case "thread/status/changed": {
      const p = params as unknown as ThreadStatusChangedParams;
      if (p.status === "waitingOnApproval") {
        // Permission request events are generated from the actual approval
        // server-request, not from this status change. This is just a state hint.
      }
      // Status transitions are handled by the session state machine, not events.
      return [];
    }

    case "item/started": {
      const p = params as unknown as ThreadItemStartedParams;
      trackItem(p.item, state);
      return [];
    }

    case "item/agentMessage/delta": {
      const p = params as unknown as AgentMessageDeltaParams;
      return [{ type: "session:response", text: p.delta }];
    }

    case "item/completed": {
      const p = params as unknown as ThreadItemCompletedParams;
      trackItem(p.item, state);

      // Accumulate the last agent message as the result text
      if (p.item.type === "agentMessage" && p.item.text) {
        state.lastResultText = p.item.text;
      }
      return [];
    }

    case "turn/diff/updated": {
      const p = params as unknown as TurnDiffUpdatedParams;
      state.currentDiff = p.diff;
      return [];
    }

    case "thread/tokenUsage/updated": {
      const p = params as unknown as TokenUsageUpdatedParams;
      state.totalTokens = p.tokenUsage.total.inputTokens + p.tokenUsage.total.outputTokens;
      state.reasoningTokens = p.tokenUsage.total.reasoningOutputTokens;
      return [];
    }

    case "turn/completed": {
      const p = params as unknown as TurnCompletedParams;
      state.numTurns++;

      const result: AgentResult = {
        result: state.lastResultText,
        cost: null, // Codex doesn't report cost
        tokens: state.totalTokens,
        numTurns: state.numTurns,
        diff: state.currentDiff ?? undefined,
      };

      if (p.status === "failed") {
        return [{ type: "session:error", errors: [p.reason ?? "Turn failed"], cost: null }];
      }

      return [{ type: "session:result", result }];
    }

    default:
      return [];
  }
}

/**
 * Map a server-initiated approval request to an AgentPermissionRequest.
 *
 * Returns null if the approval type is unrecognized.
 */
export function mapApprovalToPermission(
  method: string,
  params: Record<string, unknown>,
  state: EventMapState,
): AgentPermissionRequest | null {
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const p = params as unknown as CommandExecutionApprovalParams;
      return {
        requestId: String(p.approvalId),
        toolName: "Bash",
        input: { command: p.command },
        inputSummary: `Run: ${p.command}`,
      };
    }

    case "item/fileChange/requestApproval": {
      const p = params as unknown as FileChangeApprovalParams;
      // Look up file paths from tracked item/started events
      const files = state.itemFiles.get(p.itemId) ?? [];
      const filePath = files[0] ?? "unknown";
      return {
        requestId: String(p.approvalId),
        toolName: "Write",
        input: { file_path: filePath, files },
        inputSummary: files.length > 0 ? `Write: ${files.join(", ")}` : "Write: unknown file",
      };
    }

    default:
      return null;
  }
}

/** Track item metadata (file paths, commands) from item/started and item/completed events. */
function trackItem(item: ThreadItem, state: EventMapState): void {
  if (item.changes && item.changes.length > 0) {
    state.itemFiles.set(
      item.id,
      item.changes.map((c) => c.path),
    );
  }
  if (item.command) {
    state.itemCommands.set(item.id, item.command);
  }
}
