/**
 * `git-remote-mcx` — git remote helper mode.
 *
 * Invoked when the mcx binary is called via a symlink named `git-remote-mcx`.
 * Git passes the remote name and URL as argv[2] and argv[3]:
 *
 *   argv = ["bun", "git-remote-mcx", "origin", "mcx://confluence/FOO"]
 *
 * URL scheme: mcx://<provider>/<scope>
 *   mcx://confluence/FOO    — Confluence space FOO
 *   mcx://jira/PROJ         — Jira project PROJ
 *   mcx://asana/workspace   — Asana workspace
 *
 * Import/export handler bodies are implemented in sibling issues #1211/#1212;
 * this module wires up dispatch + URL parsing and returns "unsupported" for
 * those operations until they land.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runProtocol } from "@mcp-cli/clone";

export interface ParsedRemoteUrl {
  provider: string;
  scope: string;
}

/**
 * Parse `mcx://<provider>/<scope>` into its components.
 * The scope may contain additional `/` characters and is preserved verbatim.
 */
export function parseRemoteUrl(url: string): ParsedRemoteUrl {
  const prefix = "mcx://";
  if (!url.startsWith(prefix)) {
    throw new Error(`Invalid remote URL "${url}": expected scheme "mcx://"`);
  }
  const rest = url.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash === -1 || slash === 0 || slash === rest.length - 1) {
    throw new Error(`Invalid remote URL "${url}": expected "mcx://<provider>/<scope>"`);
  }
  return { provider: rest.slice(0, slash), scope: rest.slice(slash + 1) };
}

export interface GitRemoteHelperOptions {
  argv?: string[];
  gitDir?: string;
  stdin?: ReadableStream<Uint8Array>;
  stdout?: WritableStream<Uint8Array>;
}

/**
 * Entry point for git-remote-mcx mode.
 */
export async function runGitRemoteHelper(opts: GitRemoteHelperOptions = {}): Promise<void> {
  const argv = opts.argv ?? process.argv;
  // argv = [runtime, "git-remote-mcx", <remote-name>, <url>]
  const remoteName = argv[2];
  const remoteUrl = argv[3];
  if (!remoteUrl) {
    throw new Error("git-remote-mcx: missing remote URL argument");
  }
  // Parse now so invocation fails fast on a bad URL. Results will be passed
  // to real handlers when #1211/#1212 land.
  const { provider, scope } = parseRemoteUrl(remoteUrl);
  void remoteName;
  void provider;
  void scope;

  const gitDir = opts.gitDir ?? process.env.GIT_DIR;
  if (!gitDir) {
    throw new Error("git-remote-mcx: GIT_DIR environment variable is not set");
  }

  const marksDir = join(gitDir, "mcx");
  mkdirSync(marksDir, { recursive: true });

  const stdin = opts.stdin ?? (Bun.stdin.stream() as ReadableStream<Uint8Array>);
  const stdout =
    opts.stdout ??
    new WritableStream<Uint8Array>({
      write(chunk) {
        process.stdout.write(chunk);
      },
    });

  // Until #1211/#1212 land, handlers return safe empty responses rather than
  // throwing — a thrown exception becomes a Bun stack trace on stderr and
  // `fatal: remote helper aborted` from git, which is worse than an empty
  // fetch/push result.
  await runProtocol(
    stdin,
    stdout,
    {
      list: async () => "",
      handleImport: async () => "done\n",
      handleExport: async (exportStdin) => {
        const reader = exportStdin.getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
        reader.releaseLock();
        return "\n";
      },
    },
    { marksDir },
  );
}

/** Returns true if argv[1]'s basename is "git-remote-mcx" (with optional .exe). */
export function isGitRemoteHelperInvocation(argv1: string): boolean {
  const base = argv1.split(/[\\/]/).pop() ?? "";
  return base === "git-remote-mcx" || base === "git-remote-mcx.exe";
}
