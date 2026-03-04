/**
 * `mcp alias {ls,save,show,edit,rm}` — alias CRUD commands.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AliasDetail, AliasInfo } from "@mcp-cli/core";
import { ipcCall, safeAliasPath } from "@mcp-cli/core";
import { readFileWithLimit } from "../file-read.js";
import { printAliasDebug, printAliasList, printError } from "../output.js";

/** Wrap a defineAlias object literal body into a full script */
export function wrapDefineAlias(code: string): string {
  return `import { defineAlias, z } from "mcp-cli";\ndefineAlias(({ mcp, z }) => (${code}));\n`;
}

/** Extract the `name` field from a defineAlias object literal (no execution) */
export function extractDefinitionName(code: string): string | undefined {
  const match = code.match(/name\s*:\s*["']([^"']+)["']/);
  return match?.[1];
}

/** Default defineAlias skeleton for new aliases */
export const DEFINE_ALIAS_SKELETON = `import { defineAlias, z } from "mcp-cli";

defineAlias(({ mcp, z }) => ({
  name: "my-alias",
  description: "Describe what this alias does",
  input: z.object({}),
  fn: async (input, ctx) => {
    // Your implementation here
  },
}));
`;

export async function cmdAlias(args: string[]): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case "ls":
    case "list": {
      const verbose = args.includes("--verbose") || args.includes("-v");
      const aliases = (await ipcCall("listAliases")) as AliasInfo[];
      printAliasList(aliases, { verbose });
      break;
    }

    case "save": {
      // Parse -c / --code flag
      const codeIdx = args.indexOf("-c") !== -1 ? args.indexOf("-c") : args.indexOf("--code");
      const hasCode = codeIdx !== -1;

      if (hasCode) {
        // mcp alias save [-c CODE] [name]
        // or: mcp alias save [name] -c CODE
        const codeBody = args[codeIdx + 1];
        if (!codeBody) {
          printError("Missing code body after -c/--code flag");
          process.exit(1);
        }

        // Collect remaining args (not -c or its value) after "save"
        const rest = args.slice(1).filter((_, i) => {
          const absIdx = i + 1; // offset because we sliced at 1
          return absIdx !== codeIdx && absIdx !== codeIdx + 1;
        });
        const positionalName = rest[0];

        const definitionName = extractDefinitionName(codeBody);
        const name = positionalName ?? definitionName;
        if (!name) {
          printError("No alias name — provide a name field in the definition or as a positional arg");
          process.exit(1);
        }

        const script = wrapDefineAlias(codeBody);
        const description = extractDescription(script);
        const result = (await ipcCall("saveAlias", { name, script, description })) as {
          ok: boolean;
          filePath: string;
        };
        console.error(`Saved alias "${name}" → ${result.filePath}`);
        break;
      }

      // Standard save: mcp alias save <name> <@file | - | script>
      const name = args[1];
      if (!name) {
        printError(
          "Usage: mcp alias save <name> <@file | - | script>\n       mcp alias save -c '{...defineAlias body...}'",
        );
        process.exit(1);
      }

      const source = args[2];
      let script: string;

      if (!source || source === "-") {
        // Read from stdin
        script = await readStdin();
      } else if (source.startsWith("@")) {
        // Read from file
        script = readFileWithLimit(source.slice(1));
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
      const debug = args.includes("--debug");
      const name = args.filter((a) => a !== "--debug")[1];
      if (!name) {
        printError("Usage: mcp alias show <name> [--debug]");
        process.exit(1);
      }

      const alias = (await ipcCall("getAlias", { name })) as AliasDetail | null;
      if (!alias) {
        printError(`Alias "${name}" not found`);
        process.exit(1);
      }

      if (debug) {
        printAliasDebug(alias);
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
      let filePath: string;

      if (alias) {
        filePath = alias.filePath;
      } else {
        // New alias — create file with defineAlias skeleton
        filePath = safeAliasPath(name);
        const skeleton = DEFINE_ALIAS_SKELETON.replace('name: "my-alias"', `name: "${name}"`);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, skeleton, "utf-8");
        console.error(`Creating new alias "${name}"…`);
      }

      const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
      const result = spawnSync(editor, [filePath], { stdio: "inherit" });
      if (result.status !== 0) {
        printError(`Editor exited with code ${result.status}`);
        process.exit(1);
      }

      // Re-save to update timestamp and extract metadata
      const updatedScript = readFileWithLimit(filePath);
      const description = extractDescription(updatedScript);
      await ipcCall("saveAlias", { name, script: updatedScript, description });
      console.error(`${alias ? "Updated" : "Saved"} alias "${name}"`);
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

    default: {
      printAliasHelp();
      const isHelp = !sub || sub === "help" || sub === "--help" || sub === "-h";
      if (!isHelp) process.exit(1);
      break;
    }
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

/** Print help text with defineAlias usage examples */
function printAliasHelp(): void {
  console.error(`Usage: mcp alias <command> [options]

Commands:
  ls, list          List all aliases (-v for signatures)
  save <name> ...   Save an alias
  show <name>       Show alias source (--debug for metadata)
  edit <name>       Open alias in $EDITOR
  rm, delete        Delete an alias

Examples:

  # Structured alias with typed I/O (recommended):
  mcp alias save my-tool @my-tool.ts

  # Where my-tool.ts contains:
  #   defineAlias(({ mcp, z }) => ({
  #     name: 'my-tool',
  #     description: 'Look up a user by email',
  #     input: z.object({ email: z.string().email() }),
  #     output: z.object({ id: z.string(), name: z.string() }),
  #     fn: async ({ email }, { mcp }) => {
  #       const user = await mcp.db.find_user({ email });
  #       return { id: user.id, name: user.name };
  #     },
  #   }));

  # Inline structured alias:
  mcp alias save greet -c '{ name: "greet", description: "Say hello", input: z.string(), output: z.string(), fn: (name) => \`Hello, \${name}!\` }'

  # Legacy freeform script (still supported):
  mcp alias save my-script @script.ts

  # Inspect parsed metadata:
  mcp alias show my-tool --debug`);
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
