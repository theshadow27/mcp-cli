/**
 * `mcx pr` — GitHub PR helpers that are worktree-aware.
 *
 * Unlike `gh pr merge --delete-branch`, `mcx pr merge` never attempts local
 * branch deletion, avoiding the "cannot delete branch used by worktree" error
 * (#1800). Local cleanup is left to `mcx claude bye` → cleanupWorktree.
 */

import type { IpcMethod, IpcMethodResult, PrThreadSnapshot } from "@mcp-cli/core";
import { DEFAULT_TIMEOUT_MS, findGitRoot, openEventStream } from "@mcp-cli/core";
import { ipcCall as defaultIpcCall } from "../daemon-lifecycle";
import { printError as defaultPrintError } from "../output";

// ── Deps ──

export interface PrDeps {
  exec: (cmd: string[]) => { stdout: string; stderr: string; exitCode: number };
  printError: (msg: string) => void;
  exit: (code: number) => never;
  sleep: (ms: number) => Promise<void>;
  ipcCall: <M extends IpcMethod>(method: M, params?: unknown) => Promise<IpcMethodResult[M]>;
  repoRoot: () => string;
}

export const defaultPrDeps: PrDeps = {
  exec: (cmd) => {
    const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return {
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      exitCode: result.exitCode ?? 1,
    };
  },
  printError: defaultPrintError,
  exit: (code) => process.exit(code),
  sleep: (ms) => Bun.sleep(ms),
  ipcCall: defaultIpcCall,
  repoRoot: () => findGitRoot(process.cwd()) ?? process.cwd(),
};

// ── Copilot user detection ──

const COPILOT_USERS = new Set(["Copilot", "copilot-pull-request-reviewer[bot]"]);

// ── Arg parsing ──

export interface PrMergeArgs {
  prNumber: string | undefined;
  squash: boolean;
  rebase: boolean;
  mergeCommit: boolean;
  auto: boolean;
  wait: boolean;
  timeout: number;
  error: string | undefined;
}

export function parsePrMergeArgs(args: string[]): PrMergeArgs {
  let prNumber: string | undefined;
  let squash = false;
  let rebase = false;
  let mergeCommit = false;
  let auto = false;
  let wait = false;
  let timeout = DEFAULT_TIMEOUT_MS;
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--squash") {
      squash = true;
    } else if (arg === "--rebase") {
      rebase = true;
    } else if (arg === "--merge") {
      mergeCommit = true;
    } else if (arg === "--auto") {
      auto = true;
    } else if (arg === "--wait") {
      wait = true;
    } else if (arg === "--timeout" || arg === "-t") {
      const val = args[++i];
      if (!val) {
        error = "--timeout requires a value in ms";
      } else {
        timeout = Number(val);
        if (Number.isNaN(timeout)) error = "--timeout must be a number";
      }
    } else if (!arg.startsWith("-")) {
      prNumber = arg;
    }
  }

  if (!prNumber && !error) {
    error = "Usage: mcx pr merge <pr-number> [--squash|--rebase|--merge] [--auto] [--wait] [--timeout/-t <ms>]";
  }

  // Default to squash if no strategy given
  if (!squash && !rebase && !mergeCommit) squash = true;

  return { prNumber, squash, rebase, mergeCommit, auto, wait, timeout, error };
}

export interface PrCommentsArgs {
  prNumber: number | undefined;
  json: boolean;
  includeResolved: boolean;
  error: string | undefined;
}

export function parsePrCommentsArgs(args: string[]): PrCommentsArgs {
  let prNumber: number | undefined;
  let json = false;
  let includeResolved = false;
  let error: string | undefined;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--include-resolved") {
      includeResolved = true;
    } else if (!arg.startsWith("-")) {
      prNumber = Number(arg);
      if (Number.isNaN(prNumber)) error = `Invalid PR number: ${arg}`;
    } else {
      error = `Unknown flag: ${arg}`;
    }
  }

  if (prNumber === undefined && !error) {
    error = "Usage: mcx pr comments <pr-number> [--json] [--include-resolved]";
  }

  return { prNumber, json, includeResolved, error };
}

export interface PrWaitArgs {
  prNumber: number | undefined;
  maxWaitMs: number;
  error: string | undefined;
}

export function parsePrWaitArgs(args: string[]): PrWaitArgs {
  let prNumber: number | undefined;
  let maxWaitMs = 600_000;
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--max-wait") {
      const val = args[++i];
      if (!val) {
        error = "--max-wait requires a value in seconds";
      } else {
        const secs = Number(val);
        if (Number.isNaN(secs)) {
          error = "--max-wait must be a number";
        } else {
          maxWaitMs = secs * 1000;
        }
      }
    } else if (!arg.startsWith("-")) {
      prNumber = Number(arg);
      if (Number.isNaN(prNumber)) error = `Invalid PR number: ${arg}`;
    } else {
      error = `Unknown flag: ${arg}`;
    }
  }

  if (prNumber === undefined && !error) {
    error = "Usage: mcx pr wait-for-copilot <pr-number> [--max-wait <seconds>]";
  }

  return { prNumber, maxWaitMs, error };
}

// ── Subcommands ──

export async function prMerge(args: string[], deps: Partial<PrDeps> = {}): Promise<void> {
  const d: PrDeps = { ...defaultPrDeps, ...deps };
  const parsed = parsePrMergeArgs(args);

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  if (!parsed.prNumber) {
    d.printError("Usage: mcx pr merge <pr-number>");
    d.exit(1);
  }
  const prNum = parsed.prNumber;

  // Build gh pr merge command.
  // --delete-branch is intentionally omitted: it fails with "cannot delete branch
  // used by worktree" when the branch is checked out in an active worktree (#1800).
  // Local branch cleanup is handled by `mcx claude bye` → cleanupWorktree.
  const mergeCmd = ["gh", "pr", "merge", prNum];
  if (parsed.squash) mergeCmd.push("--squash");
  else if (parsed.rebase) mergeCmd.push("--rebase");
  else if (parsed.mergeCommit) mergeCmd.push("--merge");
  if (parsed.auto) mergeCmd.push("--auto");

  const { exitCode, stdout, stderr } = d.exec(mergeCmd);

  if (exitCode !== 0) {
    d.printError(stderr || `gh pr merge exited with code ${exitCode}`);
    d.exit(exitCode);
  }

  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);

  if (!parsed.wait) return;

  // Poll until PR reaches MERGED state
  const deadline = Date.now() + parsed.timeout;
  while (Date.now() < deadline) {
    const {
      stdout: state,
      stderr: viewStderr,
      exitCode: viewExit,
    } = d.exec(["gh", "pr", "view", prNum, "--json", "state", "-q", ".state"]);

    if (viewExit !== 0) {
      d.printError(viewStderr || `gh pr view exited with code ${viewExit}`);
      d.exit(viewExit);
      return;
    }

    const upper = state.toUpperCase();
    if (upper === "MERGED") {
      console.error(`PR #${prNum} merged.`);
      return;
    }
    if (upper === "CLOSED") {
      d.printError(`PR #${prNum} was closed without merging.`);
      d.exit(1);
      return;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await d.sleep(Math.min(10_000, remaining));
  }

  d.printError(`PR #${prNum} not yet merged (timed out after ${parsed.timeout}ms).`);
  d.exit(124);
}

export async function prComments(args: string[], deps: Partial<PrDeps> = {}): Promise<void> {
  const d: PrDeps = { ...defaultPrDeps, ...deps };
  const parsed = parsePrCommentsArgs(args);

  if (parsed.error || parsed.prNumber === undefined) {
    d.printError(parsed.error ?? "Usage: mcx pr comments <pr-number> [--json] [--include-resolved]");
    d.exit(1);
  }

  const snapshot = await d.ipcCall("getPrThreadSnapshot", {
    prNumber: parsed.prNumber,
    repoRoot: d.repoRoot(),
    includeResolved: parsed.includeResolved,
  });

  if (parsed.json) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    console.log(formatSnapshotXml(snapshot));
  }
}

export async function prWaitForCopilot(args: string[], deps: Partial<PrDeps> = {}): Promise<void> {
  const d: PrDeps = { ...defaultPrDeps, ...deps };
  const parsed = parsePrWaitArgs(args);

  if (parsed.error || parsed.prNumber === undefined) {
    d.printError(parsed.error ?? "Usage: mcx pr wait-for-copilot <pr-number> [--max-wait <seconds>]");
    d.exit(1);
  }

  const prNumber = parsed.prNumber;
  const deadline = Date.now() + parsed.maxWaitMs;
  const repoRoot = d.repoRoot();

  const ready = await checkCopilotReady(prNumber, repoRoot, d);
  if (ready) return;

  const { events, abort } = openEventStream({
    pr: prNumber,
    type: "pr.review_comment_posted",
    repo: repoRoot,
  });

  try {
    for await (const _event of events) {
      if (Date.now() >= deadline) break;
      const nowReady = await checkCopilotReady(prNumber, repoRoot, d);
      if (nowReady) return;
    }
  } finally {
    abort();
  }

  if (Date.now() >= deadline) {
    d.printError(`Timed out waiting for Copilot on PR #${prNumber} (${parsed.maxWaitMs / 1000}s).`);
    d.exit(1);
  }
}

async function checkCopilotReady(prNumber: number, repoRoot: string, d: PrDeps): Promise<boolean> {
  const snapshot = await d.ipcCall("getPrThreadSnapshot", {
    prNumber,
    repoRoot,
    includeResolved: true,
  });

  const hasCopilot =
    snapshot.threads.some((t) => COPILOT_USERS.has(t.user)) || snapshot.reviews.some((r) => COPILOT_USERS.has(r.user));

  if (!hasCopilot) return false;

  // Push-age check: fetchedAt - pushedAt must be ≥ 90s.
  // The pushedAt is not in the snapshot (would need separate API call).
  // Use the head commit date from gh api as a proxy.
  const { stdout, exitCode } = d.exec([
    "gh",
    "api",
    `repos/{owner}/{repo}/pulls/${prNumber}`,
    "--jq",
    ".pushed_at // .updated_at",
  ]);

  if (exitCode !== 0 || !stdout) return hasCopilot;

  const pushedAt = new Date(stdout).getTime();
  if (Number.isNaN(pushedAt)) return hasCopilot;

  return Date.now() - pushedAt >= 90_000;
}

// ── XML formatter ──

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatSnapshotXml(snapshot: PrThreadSnapshot): string {
  const lines: string[] = [];
  lines.push(`<pr-threads fetchedAt="${escapeXml(snapshot.fetchedAt)}">`);

  for (const thread of snapshot.threads) {
    lines.push(
      `  <thread id="${escapeXml(thread.threadId)}" location="${escapeXml(thread.location)}" resolved="${thread.resolved}" outdated="${thread.outdated}">`,
    );
    lines.push(`    <comment user="${escapeXml(thread.user)}">`);
    lines.push(`      ${escapeXml(thread.body)}`);
    lines.push("    </comment>");
    for (const reply of thread.replies) {
      lines.push(`    <reply user="${escapeXml(reply.user)}">`);
      lines.push(`      ${escapeXml(reply.body)}`);
      lines.push("    </reply>");
    }
    lines.push("  </thread>");
  }

  if (snapshot.reviews.length > 0) {
    lines.push("  <reviews>");
    for (const review of snapshot.reviews) {
      lines.push(`    <review id="${review.id}" user="${escapeXml(review.user)}" state="${escapeXml(review.state)}">`);
      if (review.body) {
        lines.push(`      ${escapeXml(review.body)}`);
      }
      lines.push("    </review>");
    }
    lines.push("  </reviews>");
  }

  if (snapshot.topLevelComments.length > 0) {
    lines.push("  <comments>");
    for (const comment of snapshot.topLevelComments) {
      lines.push(`    <comment id="${comment.id}" user="${escapeXml(comment.user)}">`);
      lines.push(`      ${escapeXml(comment.body)}`);
      lines.push("    </comment>");
    }
    lines.push("  </comments>");
  }

  lines.push("</pr-threads>");
  return lines.join("\n");
}

// ── Entry point ──

export async function cmdPr(args: string[], deps: Partial<PrDeps> = {}): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printPrUsage();
    return;
  }

  const subArgs = args.slice(1);

  switch (sub) {
    case "merge":
      await prMerge(subArgs, deps);
      break;
    case "comments":
      await prComments(subArgs, deps);
      break;
    case "wait-for-copilot":
      await prWaitForCopilot(subArgs, deps);
      break;
    default: {
      const d: Pick<PrDeps, "printError" | "exit"> = { ...defaultPrDeps, ...deps };
      d.printError(`Unknown pr subcommand: ${sub}. Run "mcx pr --help" for usage.`);
      d.exit(1);
    }
  }
}

function printPrUsage(): void {
  console.log(`mcx pr — worktree-aware GitHub PR helpers

Usage:
  mcx pr merge <pr>                       Merge PR without local-branch cleanup errors
  mcx pr merge <pr> --auto                Enable auto-merge (merges when CI passes)
  mcx pr merge <pr> --auto --wait         Enable auto-merge + block until merged
  mcx pr comments <pr>                    Show PR threads (XML for LLM consumption)
  mcx pr comments <pr> --json             Show PR threads as JSON
  mcx pr comments <pr> --include-resolved Include resolved threads
  mcx pr wait-for-copilot <pr>            Block until Copilot review is ready
  mcx pr wait-for-copilot <pr> --max-wait 300  Custom timeout in seconds (default: 600)

Merge strategy (default: --squash):
  --squash                                Squash and merge
  --rebase                                Rebase and merge
  --merge                                 Create a merge commit

Options:
  --auto                                  Enable auto-merge (requires branch protection)
  --wait                                  Block until the PR reaches MERGED state
  --timeout, -t <ms>                      Max wait time (default: ${DEFAULT_TIMEOUT_MS})

Unlike 'gh pr merge --delete-branch', 'mcx pr merge' never attempts local branch
deletion. Use 'mcx claude bye' to clean up the worktree and local branch once
the PR is merged.`);
}
