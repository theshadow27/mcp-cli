export interface CommandHelp {
  name: string;
  summary: string;
  usage: string[];
  options?: Array<[flag: string, description: string]>;
  examples?: string[];
}

const registry = new Map<string, CommandHelp>();

export function registerHelp(key: string, help: CommandHelp): void {
  registry.set(key, help);
}

export function getHelp(key: string): CommandHelp | undefined {
  return registry.get(key);
}

export function hasHelpFlag(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

export const CLAUDE_SUB_ALIASES: Readonly<Record<string, string>> = {
  list: "ls",
  quit: "bye",
  wt: "worktrees",
};

export function formatHelp(help: CommandHelp): string {
  const lines: string[] = [];

  lines.push(`${help.name} — ${help.summary}`);
  lines.push("");
  lines.push("Usage:");
  for (const u of help.usage) {
    lines.push(`  ${u}`);
  }

  if (help.options && help.options.length > 0) {
    lines.push("");
    lines.push("Options:");
    const flagWidth = Math.max(...help.options.map(([f]) => f.length));
    const pad = Math.min(flagWidth + 2, 32);
    for (const [flag, desc] of help.options) {
      lines.push(`  ${flag.padEnd(pad)}${desc}`);
    }
  }

  if (help.examples && help.examples.length > 0) {
    lines.push("");
    lines.push("Examples:");
    for (const ex of help.examples) {
      lines.push(`  ${ex}`);
    }
  }

  return lines.join("\n");
}
