/**
 * `mcx pr` — GitHub PR helpers that are worktree-aware.
 *
 * Unlike `gh pr merge --delete-branch`, `mcx pr merge` never attempts local
 * branch deletion, avoiding the "cannot delete branch used by worktree" error
 * (#1800). Local cleanup is left to `mcx claude bye` → cleanupWorktree.
 */

import { printError as defaultPrintError } from "../output";

// ── Deps ──

export interface PrDeps {
  exec: (cmd: string[]) => { stdout: string; stderr: string; exitCode: number };
  printError: (msg: string) => void;
  exit: (code: number) => never;
  sleep: (ms: number) => Promise<void>;
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
  let prNumber: string | undefined;
  let squash = false;
  let rebase = false;
  let mergeCommit = false;
  let auto = false;
  let wait = false;
  let timeout = 270_000;
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
    error = "Usage: mcx pr merge <pr-number> [--squash] [--auto] [--wait]";
  }

  // Default to squash if no strategy given
  if (!squash && !rebase && !mergeCommit) squash = true;

  return { prNumber, squash, rebase, mergeCommit, auto, wait, timeout, error };
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
    const { stdout: state, exitCode: viewExit } = d.exec([
      "gh",
      "pr",
      "view",
      prNum,
      "--json",
      "state",
      "-q",
      ".state",
    ]);

    if (viewExit === 0) {
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
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await d.sleep(Math.min(10_000, remaining));
  }

  d.printError(`PR #${prNum} not yet merged (timed out after ${parsed.timeout}ms).`);
  d.exit(124);
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
    default: {
      const d: Pick<PrDeps, "printError" | "exit"> = { ...defaultPrDeps, ...deps };
      d.printError(`Unknown pr subcommand: ${sub}. Use "merge".`);
      d.exit(1);
    }
  }
}

function printPrUsage(): void {
  console.log(`mcx pr — worktree-aware GitHub PR helpers

Usage:
  mcx pr merge <pr>                    Merge PR without local-branch cleanup errors
  mcx pr merge <pr> --auto             Enable auto-merge (merges when CI passes)
  mcx pr merge <pr> --auto --wait      Enable auto-merge + block until merged

Merge strategy (default: --squash):
  --squash                             Squash and merge
  --rebase                             Rebase and merge
  --merge                              Create a merge commit

Options:
  --auto                               Enable auto-merge (requires branch protection)
  --wait                               Block until the PR reaches MERGED state
  --timeout, -t <ms>                   Max wait time (default: 270000)

Unlike 'gh pr merge --delete-branch', 'mcx pr merge' never attempts local branch
deletion. Use 'mcx claude bye' to clean up the worktree and local branch once
the PR is merged.`);
}
