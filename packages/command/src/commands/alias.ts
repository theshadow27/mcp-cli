/**
 * `mcp alias {ls,save,show,edit,rm}` — alias CRUD commands.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AliasDetail, AliasInfo } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { printAliasList, printError } from "../output.js";

export async function cmdAlias(args: string[]): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case "ls":
    case "list": {
      const aliases = (await ipcCall("listAliases")) as AliasInfo[];
      printAliasList(aliases);
      break;
    }

    case "save": {
      const name = args[1];
      if (!name) {
        printError("Usage: mcp alias save <name> <@file | - | script>");
        process.exit(1);
      }

      const source = args[2];
      let script: string;

      if (!source || source === "-") {
        // Read from stdin
        script = await readStdin();
      } else if (source.startsWith("@")) {
        // Read from file
        script = readFileSync(source.slice(1), "utf-8");
      } else {
        // Inline script (remaining args joined)
        script = args.slice(2).join(" ");
      }

      if (!script.trim()) {
        printError("Empty script — nothing to save");
        process.exit(1);
      }

      const description = extractDescription(script);
      const result = (await ipcCall("saveAlias", { name, script, description })) as {
        ok: boolean;
        filePath: string;
      };
      console.error(`Saved alias "${name}" → ${result.filePath}`);
      break;
    }

    case "show": {
      const name = args[1];
      if (!name) {
        printError("Usage: mcp alias show <name>");
        process.exit(1);
      }

      const alias = (await ipcCall("getAlias", { name })) as AliasDetail | null;
      if (!alias) {
        printError(`Alias "${name}" not found`);
        process.exit(1);
      }

      console.log(alias.script);
      break;
    }

    case "edit": {
      const name = args[1];
      if (!name) {
        printError("Usage: mcp alias edit <name>");
        process.exit(1);
      }

      const alias = (await ipcCall("getAlias", { name })) as AliasDetail | null;
      if (!alias) {
        printError(`Alias "${name}" not found`);
        process.exit(1);
      }

      const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
      const result = spawnSync(editor, [alias.filePath], { stdio: "inherit" });
      if (result.status !== 0) {
        printError(`Editor exited with code ${result.status}`);
        process.exit(1);
      }

      // Re-save to update timestamp
      const updatedScript = readFileSync(alias.filePath, "utf-8");
      const description = extractDescription(updatedScript);
      await ipcCall("saveAlias", { name, script: updatedScript, description });
      console.error(`Updated alias "${name}"`);
      break;
    }

    case "rm":
    case "delete": {
      const name = args[1];
      if (!name) {
        printError("Usage: mcp alias rm <name>");
        process.exit(1);
      }

      await ipcCall("deleteAlias", { name });
      console.error(`Deleted alias "${name}"`);
      break;
    }

    default:
      printError("Usage: mcp alias {ls|save|show|edit|rm} [name]");
      process.exit(1);
  }
}

/** Read all of stdin as text */
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

/** Extract a description from a `// description: ...` comment on the first few lines */
function extractDescription(script: string): string | undefined {
  const lines = script.split("\n").slice(0, 5);
  for (const line of lines) {
    const match = line.match(/\/\/\s*description:\s*(.+)/i);
    if (match) return match[1].trim();
  }
  return undefined;
}
