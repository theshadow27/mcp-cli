/**
 * mcx track/untrack/tracked — work item tracking commands.
 *
 * Track:   mcx track <number>           Track a PR or issue
 *          mcx track --branch <name>    Track a branch
 * Untrack: mcx untrack <number>         Stop tracking
 * List:    mcx tracked                  Human-readable table
 *          mcx tracked --json           Machine-readable output
 */

import type { IpcMethod, IpcMethodResult, WorkItem } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { c, printError } from "../output";

export interface TrackDeps {
  ipcCall: <M extends IpcMethod>(method: M, params?: unknown) => Promise<IpcMethodResult[M]>;
  exit: (code: number) => never;
}

const defaultDeps: TrackDeps = {
  ipcCall,
  exit: (code) => process.exit(code),
};

// -- mcx track --

export async function cmdTrack(args: string[], deps: TrackDeps = defaultDeps): Promise<void> {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    printTrackHelp();
    return;
  }

  if (args[0] === "--branch") {
    const branch = args[1];
    if (!branch) {
      printError("Usage: mcx track --branch <name>");
      deps.exit(1);
    }
    const item = await deps.ipcCall("trackWorkItem", { branch });
    console.error(`Tracking branch ${branch} (${item.id})`);
    return;
  }

  const num = Number(args[0]);
  if (!Number.isInteger(num) || num <= 0) {
    printError(`Invalid number: ${args[0]}`);
    deps.exit(1);
  }

  const item = await deps.ipcCall("trackWorkItem", { number: num });
  console.error(`Tracking #${num} (${item.id})`);
}

// -- mcx untrack --

export async function cmdUntrack(args: string[], deps: TrackDeps = defaultDeps): Promise<void> {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: mcx untrack <number>");
    return;
  }

  const num = Number(args[0]);
  if (!Number.isInteger(num) || num <= 0) {
    printError(`Invalid number: ${args[0]}`);
    deps.exit(1);
  }

  const result = await deps.ipcCall("untrackWorkItem", { number: num });
  if (result.deleted) {
    console.error(`Untracked #${num}`);
  } else {
    console.error(`#${num} was not tracked`);
  }
}

// -- mcx tracked --

export async function cmdTracked(args: string[], deps: TrackDeps = defaultDeps): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: mcx tracked [--json] [--phase <phase>]");
    return;
  }

  const jsonFlag = args.includes("--json");
  const phaseIdx = args.indexOf("--phase");
  const phase = phaseIdx >= 0 ? args[phaseIdx + 1] : undefined;

  const items = await deps.ipcCall("listWorkItems", phase ? { phase } : {});

  if (jsonFlag) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  if (items.length === 0) {
    console.error("No tracked work items. Use `mcx track <number>` to start tracking.");
    return;
  }

  for (const item of items) {
    console.log(formatWorkItemRow(item));
  }
}

// -- Formatting --

const CI_ICONS: Record<string, string> = {
  none: "-",
  pending: "\u23F3",
  running: "\u23F3",
  passed: "\u2713",
  failed: "\u2717",
};

const REVIEW_ICONS: Record<string, string> = {
  none: "none",
  pending: "pending",
  approved: "\u2713",
  changes_requested: "\u2717",
};

/** Format a single work item as a scannable row. */
export function formatWorkItemRow(item: WorkItem): string {
  const id = item.id.padEnd(10);
  const pr = item.prNumber ? `PR #${item.prNumber}` : "      ";
  const prPad = pr.padEnd(10);
  const ci = `CI ${CI_ICONS[item.ciStatus] ?? item.ciStatus}`;
  const ciPad = ci.padEnd(8);
  const review = `review: ${REVIEW_ICONS[item.reviewStatus] ?? item.reviewStatus}`;
  const reviewPad = review.padEnd(20);
  const phase = `phase: ${item.phase}`;
  const phasePad = phase.padEnd(14);
  const branch = item.branch ? `  ${c.dim}${item.branch}${c.reset}` : "";

  return `${c.cyan}${id}${c.reset}  ${prPad}  ${ciPad}  ${reviewPad}  ${phasePad}${branch}`;
}

function printTrackHelp(): void {
  console.log(`mcx track — work item tracking

Usage:
  mcx track <number>           Track a PR or issue number
  mcx track --branch <name>    Track a branch (PR may not exist yet)
  mcx untrack <number>         Stop tracking a work item
  mcx tracked                  List all tracked work items
  mcx tracked --json           Machine-readable output
  mcx tracked --phase <phase>  Filter by phase (impl, review, repair, qa, done)

Examples:
  mcx track 1135
  mcx track --branch feat/new-feature
  mcx untrack 1135
  mcx tracked
  mcx tracked --json`);
}
