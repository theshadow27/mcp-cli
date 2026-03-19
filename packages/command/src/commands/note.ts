/**
 * mcx note — per-tool annotations.
 *
 * Set:   mcx note set <server>.<tool> "note text"
 * List:  mcx note ls
 * Get:   mcx note get <server>.<tool>
 * Remove: mcx note rm <server>.<tool>
 */

import type { IpcMethod, IpcMethodResult } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { c, printError } from "../output";

export interface NoteDeps {
  ipcCall: <M extends IpcMethod>(method: M, params?: unknown) => Promise<IpcMethodResult[M]>;
  exit: (code: number) => never;
}

const defaultDeps: NoteDeps = {
  ipcCall,
  exit: (code) => process.exit(code),
};

/**
 * Parse "server.tool" into [server, tool].
 * Only splits on the first dot — tool names don't contain dots.
 */
function parseKey(key: string): [string, string] | null {
  const dot = key.indexOf(".");
  if (dot <= 0 || dot === key.length - 1) return null;
  return [key.slice(0, dot), key.slice(dot + 1)];
}

export async function cmdNote(args: string[], deps: NoteDeps = defaultDeps): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printNoteHelp();
    return;
  }

  switch (sub) {
    case "set": {
      const key = args[1];
      const note = args.slice(2).join(" ");
      if (!key || !note) {
        printError('Usage: mcx note set <server>.<tool> "note text"');
        deps.exit(1);
      }
      const parsed = parseKey(key);
      if (!parsed) {
        printError(`Invalid key "${key}". Expected format: server.tool`);
        deps.exit(1);
      }
      const [server, tool] = parsed;
      await deps.ipcCall("setNote", { server, tool, note });
      console.error(`Note set for ${server}.${tool}`);
      break;
    }

    case "get": {
      const key = args[1];
      if (!key) {
        printError("Usage: mcx note get <server>.<tool>");
        deps.exit(1);
      }
      const parsed = parseKey(key);
      if (!parsed) {
        printError(`Invalid key "${key}". Expected format: server.tool`);
        deps.exit(1);
      }
      const [server, tool] = parsed;
      const result = await deps.ipcCall("getNote", { server, tool });
      if (result.note) {
        console.log(result.note);
      } else {
        console.error(`No note for ${server}.${tool}`);
      }
      break;
    }

    case "ls":
    case "list": {
      const notes = await deps.ipcCall("listNotes");
      if (notes.length === 0) {
        console.error('No notes. Use `mcx note set <server>.<tool> "text"` to create one.');
        return;
      }
      const maxKey = Math.max(...notes.map((n) => `${n.serverName}.${n.toolName}`.length));
      for (const n of notes) {
        const key = `${n.serverName}.${n.toolName}`;
        console.log(`  ${c.green}${key.padEnd(maxKey)}${c.reset}  ${n.note}`);
      }
      console.log(`\n${notes.length} note(s)`);
      break;
    }

    case "rm":
    case "remove":
    case "delete": {
      const key = args[1];
      if (!key) {
        printError("Usage: mcx note rm <server>.<tool>");
        deps.exit(1);
      }
      const parsed = parseKey(key);
      if (!parsed) {
        printError(`Invalid key "${key}". Expected format: server.tool`);
        deps.exit(1);
      }
      const [server, tool] = parsed;
      const result = await deps.ipcCall("deleteNote", { server, tool });
      if (result.deleted) {
        console.error(`Note removed for ${server}.${tool}`);
      } else {
        console.error(`No note found for ${server}.${tool}`);
      }
      break;
    }

    default:
      printError(`Unknown note subcommand: ${sub}`);
      printNoteHelp();
      deps.exit(1);
  }
}

function printNoteHelp(): void {
  console.log(`mcx note — per-tool annotations

Usage:
  mcx note set <server>.<tool> "note text"   Set a note
  mcx note get <server>.<tool>               Get a note
  mcx note ls                                List all notes
  mcx note rm <server>.<tool>                Remove a note

Examples:
  mcx note set atlassian.editJiraIssue "use categoryId 37 for GO team"
  mcx note set atlassian.getJiraIssue "cloudId is always abc-123-def"
  mcx note ls
  mcx note rm atlassian.editJiraIssue`);
}
