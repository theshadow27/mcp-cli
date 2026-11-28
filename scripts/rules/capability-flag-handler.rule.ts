/**
 * Rule: capability-flag-handler
 *
 * A provider's `native` flags (costTracking, compactLog) gate CLI behavior. A flag set to `true` with
 * no handler in the provider's session code silently no-ops or shows misleading data. The provider
 * file is read through its syntax tree; the evidence is a text match over the provider's non-test
 * session files under packages/daemon/src/ (`<prefix>-session/`, `<prefix>-session-worker*`,
 * `<prefix>-server*`), where the prefix is the provider's `serverName` without its leading `_`.
 *
 * Sources: #2421, #2391.
 */

import { type FileMeta, type Rule, type TSESTree, walk } from "am-i-done";

const PROVIDER_REL = "packages/core/src/agent-provider.ts";
const SESSION_DIR = "packages/daemon/src/";

interface FlagEntry {
  flag: string;
  line: number;
  column: number;
}

interface ProviderInfo {
  name: string;
  serverName: string;
  flags: FlagEntry[];
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

/** The property of `obj` named `key` (an identifier key), if any. */
function findProperty(obj: TSESTree.ObjectExpression, key: string): TSESTree.Property | undefined {
  for (const prop of obj.properties) {
    if (prop.type === "Property" && !prop.computed && prop.key.type === "Identifier" && prop.key.name === key) {
      return prop;
    }
  }
  return undefined;
}

function extractProviders(program: TSESTree.Program): ProviderInfo[] {
  const results: ProviderInfo[] = [];

  walk(program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return;
    if (node.callee.name !== "registerProvider") return;
    const arg = node.arguments[0];
    if (arg?.type !== "ObjectExpression") return;

    const nameValue = findProperty(arg, "name")?.value;
    const serverNameValue = findProperty(arg, "serverName")?.value;
    const name = nameValue?.type === "Literal" && typeof nameValue.value === "string" ? nameValue.value : undefined;
    const serverName =
      serverNameValue?.type === "Literal" && typeof serverNameValue.value === "string"
        ? serverNameValue.value
        : undefined;

    const flags: FlagEntry[] = [];
    const native = findProperty(arg, "native")?.value;
    if (native?.type === "ObjectExpression") {
      for (const flagProp of native.properties) {
        if (flagProp.type !== "Property" || flagProp.computed || flagProp.key.type !== "Identifier") continue;
        if (flagProp.value.type !== "Literal" || flagProp.value.value !== true) continue;
        const flag = flagProp.key.name;
        if (flag in EVIDENCE)
          flags.push({ flag, line: flagProp.loc.start.line, column: flagProp.loc.start.column + 1 });
      }
    }

    if (name && serverName) results.push({ name, serverName, flags });
  });

  return results;
}

function sessionFilesHaveEvidence(files: ReadonlyMap<string, FileMeta>, prefix: string, pattern: RegExp): boolean {
  for (const meta of files.values()) {
    if (meta.isTest) continue;
    if (!meta.relativePath.startsWith(SESSION_DIR)) continue;
    if (!isSessionFile(meta.relativePath, prefix)) continue;
    if (pattern.test(meta.content)) return true;
  }
  return false;
}

export default {
  id: "capability-flag-handler",
  type: "check",
  category: "architecture",
  ast: true,
  scold: "Provider advertises a capability flag but no session handler exercises it",
  guidance: [
    "A provider's `native` flags (costTracking, compactLog, …) gate CLI behavior: setting one to `true` without a corresponding handler means the feature silently no-ops or displays misleading data.",
    "`costTracking: true` → the provider's session code must reference cost / total_cost_usd fields.",
    "`compactLog: true` → the provider's session code must contain a compact-log code path.",
    "Fix: add the missing handler in packages/daemon/src/<provider>-session/, or set the flag to `false`.",
  ],
  documentation: "#2421, #2391",
  tests: "exclude",
  anchors: [(files) => files.has(PROVIDER_REL)],
  check(ctx) {
    if (ctx.file.relativePath !== PROVIDER_REL) return ctx.skipped();

    for (const provider of extractProviders(ctx.ast().program)) {
      const prefix = sessionPrefix(provider.serverName);
      for (const { flag, line, column } of provider.flags) {
        const pattern = EVIDENCE[flag];
        if (!pattern) continue;
        if (!sessionFilesHaveEvidence(ctx.files, prefix, pattern)) {
          ctx.violated(
            line,
            column,
            `${provider.name}: native.${flag} is true but no handler found in ${prefix}-session/`,
          );
        }
      }
    }
    return ctx.checked();
  },
} satisfies Rule;
