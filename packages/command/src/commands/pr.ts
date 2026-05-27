/**
 * `mcx pr` — GitHub PR helpers that are worktree-aware.
 *
 * Unlike `gh pr merge --delete-branch`, `mcx pr merge` never attempts local
 * branch deletion, avoiding the "cannot delete branch used by worktree" error
 * (#1800). Local cleanup is left to `mcx claude bye` → cleanupWorktree.
 */

import type { IpcMethod, IpcMethodResult, MonitorEvent, PrThreadSnapshot } from "@mcp-cli/core";
import { COPILOT_USERS, DEFAULT_TIMEOUT_MS, findGitRoot, openEventStream, spawnCaptureSync } from "@mcp-cli/core";
import { ipcCall as defaultIpcCall } from "../daemon-lifecycle";
import { parseFlags } from "../flags";
import { printError as defaultPrintError } from "../output";

// ── Deps ──

export interface PrDeps {
  exec: (cmd: string[]) => { stdout: string; stderr: string; exitCode: number };
  printError: (msg: string) => void;
  exit: (code: number) => never;
  sleep: (ms: number) => Promise<void>;
  ipcCall: <M extends IpcMethod>(method: M, params?: unknown) => Promise<IpcMethodResult[M]>;
  repoRoot: () => string;
  openStream: (params: Record<string, unknown>) => { events: AsyncIterable<MonitorEvent>; abort: () => void };
}

export const defaultPrDeps: PrDeps = {
  exec: (cmd) => {
    const result = spawnCaptureSync(cmd[0] ?? "", cmd.slice(1));
    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      exitCode: result.exitCode ?? 1,
    };
  },
  printError: defaultPrintError,
  exit: (code) => process.exit(code),
  sleep: (ms) => Bun.sleep(ms),
  ipcCall: defaultIpcCall,
  repoRoot: () => findGitRoot(process.cwd()) ?? process.cwd(),
  openStream: openEventStream,
};

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
  const { flags, positionals, errors } = parseFlags(args, {
    squash: { type: "boolean" },
    rebase: { type: "boolean" },
    merge: { type: "boolean" },
    auto: { type: "boolean" },
    wait: { type: "boolean" },
    timeout: { type: "number", alias: "t" },
  });

  let error: string | undefined;
  if (errors.length > 0) {
    // Map parseFlags error messages to match original format
    const raw = errors[0];
    if (raw.includes("requires a value")) {
      error = "--timeout requires a value in ms";
    } else if (raw.includes("requires a numeric value")) {
      error = "--timeout must be a number";
    } else {
      error = raw;
    }
  }

  const prNumber = positionals[0] as string | undefined;
  const squash = (flags.squash as boolean | undefined) ?? false;
  const rebase = (flags.rebase as boolean | undefined) ?? false;
  const mergeCommit = (flags.merge as boolean | undefined) ?? false;
  const auto = (flags.auto as boolean | undefined) ?? false;
  const wait = (flags.wait as boolean | undefined) ?? false;
  const timeout = (flags.timeout as number | undefined) ?? DEFAULT_TIMEOUT_MS;

  if (!prNumber && !error) {
    error = "Usage: mcx pr merge <pr-number> [--squash|--rebase|--merge] [--auto] [--wait] [--timeout/-t <ms>]";
  }

  // Default to squash if no strategy given
  const finalSquash = !squash && !rebase && !mergeCommit ? true : squash;

  return { prNumber, squash: finalSquash, rebase, mergeCommit, auto, wait, timeout, error };
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

export interface PrResolveArgs {
  prNumber: number | undefined;
  threadId: string | undefined;
  allAddressed: boolean;
  replyText: string | undefined;
  error: string | undefined;
}

const RESOLVE_USAGE =
  "Usage: mcx pr comments <pr> resolve <thread-id> [reply text]\n       mcx pr comments <pr> resolve --all-addressed";

export function parsePrResolveArgs(args: string[]): PrResolveArgs {
  // args = [prNumber, "resolve", <thread-id | --all-addressed>, ...replyParts]
  let prNumber: number | undefined;
  let threadId: string | undefined;
  let allAddressed = false;
  let replyText: string | undefined;
  let error: string | undefined;

  if (!args[0]) {
    return { prNumber, threadId, allAddressed, replyText, error: RESOLVE_USAGE };
  }

  prNumber = Number(args[0]);
  if (Number.isNaN(prNumber)) {
    return { prNumber: undefined, threadId, allAddressed, replyText, error: `Invalid PR number: ${args[0]}` };
  }

  // args[1] is "resolve" (the subcommand marker, already validated by caller)
  const target = args[2];
  if (!target) {
    return { prNumber, threadId, allAddressed, replyText, error: RESOLVE_USAGE };
  }

  if (target === "--all-addressed") {
    allAddressed = true;
  } else if (target.startsWith("-")) {
    return { prNumber, threadId, allAddressed, replyText, error: `Unknown flag: ${target}` };
  } else {
    threadId = target;
    if (args.length > 3) {
      replyText = args.slice(3).join(" ");
    }
  }

  return { prNumber, threadId, allAddressed, replyText, error };
}

export interface PrWaitArgs {
  prNumber: number | undefined;
  maxWaitMs: number;
  error: string | undefined;
}

export function parsePrWaitArgs(args: string[]): PrWaitArgs {
  const { flags, positionals, errors } = parseFlags(args, {
    "max-wait": { type: "number" },
  });

  let error: string | undefined;
  if (errors.length > 0) {
    const raw = errors[0];
    if (raw.includes("requires a value")) {
      error = "--max-wait requires a value in seconds";
    } else if (raw.includes("requires a numeric value")) {
      error = "--max-wait must be a number";
    } else if (raw.startsWith("unknown flag:")) {
      error = `Unknown flag: ${raw.slice("unknown flag: ".length)}`;
    } else {
      error = raw;
    }
  }

  let prNumber: number | undefined;
  if (positionals.length > 0 && !error) {
    prNumber = Number(positionals[0]);
    if (Number.isNaN(prNumber)) {
      error = `Invalid PR number: ${positionals[0]}`;
      prNumber = undefined;
    }
  }

  const maxWaitSecs = flags["max-wait"] as number | undefined;
  const maxWaitMs = maxWaitSecs !== undefined ? maxWaitSecs * 1000 : 600_000;

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

  if (args[1] === "resolve") {
    return prCommentsResolve(args, d);
  }

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

export async function prCommentsResolve(args: string[], deps: Partial<PrDeps> = {}): Promise<void> {
  const d: PrDeps = { ...defaultPrDeps, ...deps };
  const parsed = parsePrResolveArgs(args);

  if (parsed.error || parsed.prNumber === undefined) {
    d.printError(parsed.error ?? RESOLVE_USAGE);
    d.exit(1);
  }

  const prNumber = parsed.prNumber as number;

  if (parsed.allAddressed) {
    const snapshot = await d.ipcCall("getPrThreadSnapshot", {
      prNumber,
      repoRoot: d.repoRoot(),
      includeResolved: false,
    });

    const toResolve = snapshot.threads.filter((t) => !t.resolved && t.replies.length > 0);
    if (toResolve.length === 0) {
      console.error("No addressed threads to resolve.");
      return;
    }

    let resolved = 0;
    for (const thread of toResolve) {
      const { exitCode, stderr } = d.exec(buildResolveCmd(thread.threadId));
      if (exitCode !== 0) {
        d.printError(`Failed to resolve thread ${thread.threadId}: ${stderr || `exit ${exitCode}`}`);
      } else {
        resolved++;
      }
    }
    console.error(`Resolved ${resolved}/${toResolve.length} addressed thread(s).`);
    if (resolved < toResolve.length) {
      d.exit(1);
      return;
    }
    return;
  }

  // Single-thread resolve
  const threadId = parsed.threadId as string;

  if (parsed.replyText) {
    const snapshot = await d.ipcCall("getPrThreadSnapshot", {
      prNumber,
      repoRoot: d.repoRoot(),
      includeResolved: true,
    });

    const thread = snapshot.threads.find((t) => t.threadId === threadId);
    if (!thread) {
      d.printError(`Thread ${threadId} not found in PR #${prNumber}`);
      d.exit(1);
    }

    const { exitCode: replyExit, stderr: replyStderr } = d.exec([
      "gh",
      "api",
      `/repos/{owner}/{repo}/pulls/${prNumber}/comments`,
      "-X",
      "POST",
      "-F",
      `body=${parsed.replyText}`,
      "-F",
      `in_reply_to=${thread.rootCommentId}`,
    ]);
    if (replyExit !== 0) {
      d.printError(replyStderr || `Failed to post reply (exit ${replyExit})`);
      d.exit(replyExit);
    }
  }

  const { exitCode, stderr } = d.exec(buildResolveCmd(threadId));
  if (exitCode !== 0) {
    d.printError(stderr || `Failed to resolve thread (exit ${exitCode})`);
    d.exit(exitCode);
  }
  console.error(`Resolved thread ${threadId}.`);
}

function buildResolveCmd(threadId: string): string[] {
  return [
    "gh",
    "api",
    "graphql",
    "-f",
    "query=mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }",
    "-f",
    `threadId=${threadId}`,
  ];
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

  const { events, abort } = d.openStream({
    pr: prNumber,
    type: "pr.review_comment_posted,review.approved,review.changes_requested,review.commented",
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

  // Stream ended without returning (daemon restart, connection drop).
  // Do a final check before giving up.
  if (Date.now() < deadline) {
    const lastCheck = await checkCopilotReady(prNumber, repoRoot, d);
    if (lastCheck) return;
  }

  d.printError(`Timed out waiting for Copilot on PR #${prNumber} (${parsed.maxWaitMs / 1000}s).`);
  d.exit(1);
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

  if (!snapshot.updatedAt) return false;

  const updatedAt = new Date(snapshot.updatedAt).getTime();
  if (Number.isNaN(updatedAt)) return false;

  return Date.now() - updatedAt >= 90_000;
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
  mcx pr merge <pr>                               Merge PR without local-branch cleanup errors
  mcx pr merge <pr> --auto                        Enable auto-merge (merges when CI passes)
  mcx pr merge <pr> --auto --wait                 Enable auto-merge + block until merged
  mcx pr comments <pr>                            Show PR threads (XML for LLM consumption)
  mcx pr comments <pr> --json                     Show PR threads as JSON
  mcx pr comments <pr> --include-resolved         Include resolved threads
  mcx pr comments <pr> resolve <thread-id>        Resolve a single review thread
  mcx pr comments <pr> resolve <thread-id> <text> Reply with text, then resolve
  mcx pr comments <pr> resolve --all-addressed    Resolve all threads that have a reply
  mcx pr wait-for-copilot <pr>                    Block until Copilot review is ready
  mcx pr wait-for-copilot <pr> --max-wait 300     Custom timeout in seconds (default: 600)

Merge strategy (default: --squash):
  --squash                                        Squash and merge
  --rebase                                        Rebase and merge
  --merge                                         Create a merge commit

Options:
  --auto                                          Enable auto-merge (requires branch protection)
  --wait                                          Block until the PR reaches MERGED state
  --timeout, -t <ms>                              Max wait time (default: ${DEFAULT_TIMEOUT_MS})

Unlike 'gh pr merge --delete-branch', 'mcx pr merge' never attempts local branch
deletion. Use 'mcx claude bye' to clean up the worktree and local branch once
the PR is merged.`);
}
