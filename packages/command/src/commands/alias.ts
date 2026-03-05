/**
 * `mcp alias {ls,save,show,edit,rm}` — alias CRUD commands.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AliasDetail, AliasInfo, IpcMethod } from "@mcp-cli/core";
import { ipcCall, safeAliasPath } from "@mcp-cli/core";
import { readFileWithLimit } from "../file-read.js";
import { printAliasDebug, printAliasList, printError } from "../output.js";

export interface AliasDeps {
  ipcCall: (method: IpcMethod, params?: unknown) => Promise<unknown>;
  readFileWithLimit: (path: string) => string;
  readStdin: () => Promise<string>;
  printError: (msg: string) => void;
  printAliasList: typeof printAliasList;
  printAliasDebug: typeof printAliasDebug;
  safeAliasPath: (name: string) => string;
  mkdirSync: (path: string, opts?: { recursive?: boolean }) => void;
  writeFileSync: (path: string, data: string, encoding: BufferEncoding) => void;
  spawnSync: (cmd: string, args: string[], opts: { stdio: string }) => { status: number | null };
  exit: (code: number) => never;
  log: (msg: string) => void;
  logError: (msg: string) => void;
}

const defaultDeps: AliasDeps = {
  ipcCall,
  readFileWithLimit,
  readStdin: defaultReadStdin,
  printError,
  printAliasList,
  printAliasDebug,
  safeAliasPath,
  mkdirSync: (path, opts) => mkdirSync(path, opts),
  writeFileSync: (path, data, enc) => writeFileSync(path, data, enc),
  spawnSync: (cmd, args, opts) => spawnSync(cmd, args, opts as Parameters<typeof spawnSync>[2]),
  exit: (code) => process.exit(code),
  log: (msg) => console.log(msg),
  logError: (msg) => console.error(msg),
};

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

export async function cmdAlias(args: string[], deps?: Partial<AliasDeps>): Promise<void> {
  const d: AliasDeps = { ...defaultDeps, ...deps };
  const sub = args[0];

  switch (sub) {
    case "ls":
    case "list": {
      const verbose = args.includes("--verbose") || args.includes("-v");
      const aliases = (await d.ipcCall("listAliases")) as AliasInfo[];
      d.printAliasList(aliases, { verbose });
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
          d.printError("Missing code body after -c/--code flag");
          d.exit(1);
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
          d.printError("No alias name — provide a name field in the definition or as a positional arg");
          d.exit(1);
        }

        const script = wrapDefineAlias(codeBody);
        const description = extractDescription(script);
        const result = (await d.ipcCall("saveAlias", { name, script, description })) as {
          ok: boolean;
          filePath: string;
        };
        d.logError(`Saved alias "${name}" → ${result.filePath}`);
        break;
      }

      // Standard save: mcp alias save <name> <@file | - | script>
      const name = args[1];
      if (!name) {
        d.printError(
          "Usage: mcp alias save <name> <@file | - | script>\n       mcp alias save -c '{...defineAlias body...}'",
        );
        d.exit(1);
      }

      const source = args[2];
      let script: string;

      if (!source || source === "-") {
        // Read from stdin
        script = await d.readStdin();
      } else if (source.startsWith("@")) {
        // Read from file
        script = d.readFileWithLimit(source.slice(1));
      } else {
        // Inline script (remaining args joined)
        script = args.slice(2).join(" ");
      }

      if (!script.trim()) {
        d.printError("Empty script — nothing to save");
        d.exit(1);
      }

      const description = extractDescription(script);
      const result = (await d.ipcCall("saveAlias", { name, script, description })) as {
        ok: boolean;
        filePath: string;
      };
      d.logError(`Saved alias "${name}" → ${result.filePath}`);
      break;
    }

    case "show": {
      const debug = args.includes("--debug");
      const name = args.filter((a) => a !== "--debug")[1];
      if (!name) {
        d.printError("Usage: mcp alias show <name> [--debug]");
        d.exit(1);
      }

      const alias = (await d.ipcCall("getAlias", { name })) as AliasDetail | null;
      if (!alias) {
        d.printError(`Alias "${name}" not found`);
        d.exit(1);
      }

      if (debug) {
        d.printAliasDebug(alias);
      }
      d.log(alias.script);
      break;
    }

    case "edit": {
      const name = args[1];
      if (!name) {
        d.printError("Usage: mcp alias edit <name>");
        d.exit(1);
      }

      const alias = (await d.ipcCall("getAlias", { name })) as AliasDetail | null;
      let filePath: string;

      if (alias) {
        filePath = alias.filePath;
      } else {
        // New alias — create file with defineAlias skeleton
        filePath = d.safeAliasPath(name);
        const skeleton = DEFINE_ALIAS_SKELETON.replace('name: "my-alias"', `name: "${name}"`);
        d.mkdirSync(dirname(filePath), { recursive: true });
        d.writeFileSync(filePath, skeleton, "utf-8");
        d.logError(`Creating new alias "${name}"…`);
      }

      const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
      const result = d.spawnSync(editor, [filePath], { stdio: "inherit" });
      if (result.status !== 0) {
        d.printError(`Editor exited with code ${result.status}`);
        d.exit(1);
      }

      // Re-save to update timestamp and extract metadata
      const updatedScript = d.readFileWithLimit(filePath);
      const description = extractDescription(updatedScript);
      await d.ipcCall("saveAlias", { name, script: updatedScript, description });
      d.logError(`${alias ? "Updated" : "Saved"} alias "${name}"`);
      break;
    }

    case "rm":
    case "delete": {
      const name = args[1];
      if (!name) {
        d.printError("Usage: mcp alias rm <name>");
        d.exit(1);
      }

      await d.ipcCall("deleteAlias", { name });
      d.logError(`Deleted alias "${name}"`);
      break;
    }

    default: {
      printAliasHelp();
      const isHelp = !sub || sub === "help" || sub === "--help" || sub === "-h";
      if (!isHelp) d.exit(1);
      break;
    }
  }
}

/** Read all of stdin as text */
async function defaultReadStdin(): Promise<string> {
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
export function extractDescription(script: string): string | undefined {
  const lines = script.split("\n").slice(0, 5);
  for (const line of lines) {
    const match = line.match(/\/\/\s*description:\s*(.+)/i);
    if (match) return match[1].trim();
  }
  return undefined;
}
