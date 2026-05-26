import ts from "typescript";

import type { AstHelper } from "./_engine/ast";
import { createAstHelper } from "./_engine/ast";
import type { FileMeta } from "./_engine/file-loader";
import type { CheckRule, RuleContext } from "./_engine/rule";

const PROVIDER_REL = "packages/core/src/agent-provider.ts";
const SESSION_DIR = "packages/daemon/src/";

interface FlagEntry {
  flag: string;
  line: number;
  col: number;
}

interface ProviderInfo {
  name: string;
  serverName: string;
  flags: FlagEntry[];
  nameLine: number;
  nameCol: number;
}

const EVIDENCE: Record<string, RegExp> = {
  costTracking: /\b(cost|total_cost_usd)\b/,
  compactLog: /\bcompact/,
};

function sessionPrefix(serverName: string): string {
  return serverName.replace(/^_/, "");
}

function isSessionFile(relPath: string, prefix: string): boolean {
  const tail = relPath.slice(SESSION_DIR.length);
  return (
    tail.startsWith(`${prefix}-session/`) ||
    tail.startsWith(`${prefix}-session-worker`) ||
    tail.startsWith(`${prefix}-server`)
  );
}

function extractProviders(ast: AstHelper): ProviderInfo[] {
  const results: ProviderInfo[] = [];

  for (const call of ast.callsTo("registerProvider")) {
    const arg = call.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) continue;

    let name: string | undefined;
    let serverName: string | undefined;
    let nameLine = 0;
    let nameCol = 0;
    const flags: FlagEntry[] = [];

    for (const prop of arg.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;

      if (prop.name.text === "name" && ts.isStringLiteral(prop.initializer)) {
        name = prop.initializer.text;
        const pos = ast.positionOf(prop.initializer);
        nameLine = pos.line;
        nameCol = pos.column;
      }

      if (prop.name.text === "serverName" && ts.isStringLiteral(prop.initializer)) {
        serverName = prop.initializer.text;
      }

      if (prop.name.text === "native" && ts.isObjectLiteralExpression(prop.initializer)) {
        for (const flagProp of prop.initializer.properties) {
          if (!ts.isPropertyAssignment(flagProp) || !ts.isIdentifier(flagProp.name)) continue;
          if (flagProp.initializer.kind === ts.SyntaxKind.TrueKeyword) {
            const flagName = flagProp.name.text;
            if (flagName in EVIDENCE) {
              const pos = ast.positionOf(flagProp);
              flags.push({ flag: flagName, line: pos.line, col: pos.col });
            }
          }
        }
      }
    }

    if (name && serverName) {
      results.push({ name, serverName, flags, nameLine, nameCol });
    }
  }

  return results;
}

function sessionFilesHaveEvidence(files: Map<string, FileMeta>, prefix: string, pattern: RegExp): boolean {
  for (const meta of files.values()) {
    if (!meta.relPath.startsWith(SESSION_DIR)) continue;
    if (!isSessionFile(meta.relPath, prefix)) continue;
    if (pattern.test(meta.content)) return true;
  }
  return false;
}

const rule: CheckRule = {
  id: "capability-flag-handler",
  kind: "check",
  scold: "Provider advertises a capability flag but no session handler exercises it",
  guidance: [
    "A provider's `native` flags (costTracking, compactLog, …) gate CLI behavior — setting one to `true` without a corresponding handler means the feature silently no-ops or displays misleading data.",
    "`costTracking: true` → the provider's session code must reference cost / total_cost_usd fields.",
    "`compactLog: true` → the provider's session code must contain a compact-log code path.",
    "Fix: add the missing handler in packages/daemon/src/<provider>-session/, or set the flag to `false`.",
  ],
  documentation: "#2421, #2391",
  appliesToTests: false,
  anchors: [PROVIDER_REL],
  check(ctx: RuleContext) {
    if (ctx.file.relPath !== PROVIDER_REL) return;
    ctx.checked();

    const providers = extractProviders(ctx.ast);
    for (const provider of providers) {
      const prefix = sessionPrefix(provider.serverName);
      for (const { flag, line, col } of provider.flags) {
        const pattern = EVIDENCE[flag];
        if (!pattern) continue;
        if (!sessionFilesHaveEvidence(ctx.files, prefix, pattern)) {
          ctx.violated(
            line,
            col,
            `${provider.name}: native.${flag} is true but no handler found in ${prefix}-session/`,
          );
        }
      }
    }
  },
};

export default rule;
