/**
 * mcx spend — per-domain spend rollup from agent_sessions (#3055, epic I / #3029).
 *
 * Usage:
 *   mcx spend                    # every domain, human table
 *   mcx spend -d phoenix         # one domain, plus its per-session/per-model rows
 *   mcx spend --since 7d         # only sessions spawned in the last 7 days
 *   mcx spend --json             # JSON to stdout instead of a table
 *
 * Calls the daemon's `_metrics` virtual server (`get_domain_spend` tool) — the same
 * rollup an agent reading its own domain's burn calls directly, so `mcx spend` and
 * `_metrics get_domain_spend` never disagree.
 *
 * Every row and total is source-labeled ("daemon" today; see docs on DomainSpendResult).
 * A number that mixed sources silently would be a number nobody could act on.
 */

import type { DomainSpendResult, IpcMethod, IpcMethodResult } from "@mcp-cli/core";
import { METRICS_SERVER_NAME, ipcCall } from "@mcp-cli/core";
import { parseFlags } from "../flags";
import { c, printError } from "../output";
import { parseDuration } from "./gc";

export interface SpendDeps {
  ipcCall: <M extends IpcMethod>(method: M, params?: unknown) => Promise<IpcMethodResult[M]>;
  now: () => number;
}

const defaultDeps: SpendDeps = {
  ipcCall,
  now: () => Date.now(),
};

/** Extract text from an MCP tool result content array (same shape every callTool result has). */
function extractText(result: unknown): string | null {
  if (result == null || typeof result !== "object") return null;
  const { content } = result as { content?: unknown };
  if (!Array.isArray(content)) return null;
  const item = (content as Array<{ type: string; text?: string }>).find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  return item?.text ?? null;
}

function isToolError(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { isError?: unknown }).isError === true;
}

function formatCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

function printAlignedTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const fmt = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ");
  console.log(`${c.bold}${fmt(header)}${c.reset}`);
  for (const row of rows) console.log(fmt(row));
}

function printHumanTable(result: DomainSpendResult, domainFilter: string | undefined): void {
  if (result.totals.length === 0) {
    printError(`spend: no spend recorded${domainFilter ? ` for domain "${domainFilter}"` : ""}`);
    return;
  }

  const header = ["DOMAIN", "SOURCE", "SESSIONS", "COST", "TOKENS"];
  const rows = result.totals.map((t) => [
    t.domain,
    t.source,
    String(t.sessionCount),
    formatCost(t.totalCost),
    String(t.totalTokens),
  ]);
  printAlignedTable(header, rows);

  const totalCost = result.totals.reduce((sum, t) => sum + t.totalCost, 0);
  const totalSessions = result.totals.reduce((sum, t) => sum + t.sessionCount, 0);
  const sources = [...new Set(result.totals.map((t) => t.source))].join(",");
  console.log(
    `\nTotal: ${formatCost(totalCost)} across ${result.totals.length} domain(s), ${totalSessions} session(s) [source: ${sources}]`,
  );

  if (domainFilter && result.sessions.length > 0) {
    console.log("\nSessions:");
    const sHeader = ["SESSION", "MODEL", "COST", "TOKENS", "SPAWNED"];
    const sRows = result.sessions.map((s) => [
      s.sessionId,
      s.model ?? "<unknown>",
      formatCost(s.cost),
      String(s.tokens),
      new Date(s.spawnedAtMs).toISOString(),
    ]);
    printAlignedTable(sHeader, sRows);
  }
}

function printUsage(): void {
  console.log(`mcx spend — per-domain spend rollup from agent_sessions

Usage:
  mcx spend                  All domains, human table
  mcx spend -d <domain>      One domain, plus its per-session/per-model rows
  mcx spend --since <dur>    Only sessions spawned within <dur> (e.g. 24h, 7d, 2w)
  mcx spend --json           JSON to stdout instead of a table

Options:
  --domain, -d <name>   Restrict to one domain
  --since <dur>          Duration suffixes: s, m, h, d, w (e.g. 3h, 7d)
  --json                 JSON to stdout
  --help, -h             Show this help

Every row and total is labeled with its source (only "daemon" exists today —
sessions the daemon itself spawned and tracked cost/tokens for).`);
}

export async function cmdSpend(args: string[], deps: SpendDeps = defaultDeps): Promise<void> {
  const { flags, errors, help } = parseFlags(args, {
    domain: { type: "string", alias: "d" },
    since: { type: "string" },
    json: { type: "boolean" },
  });

  if (help) {
    printUsage();
    return;
  }

  if (errors.length > 0) {
    printError(`spend: ${errors[0]}`);
    process.exitCode = 1;
    return;
  }

  const domain = flags.domain as string | undefined;
  const sinceRaw = flags.since as string | undefined;
  const asJson = (flags.json as boolean) ?? false;

  let sinceMs: number | undefined;
  if (sinceRaw !== undefined) {
    try {
      sinceMs = deps.now() - parseDuration(sinceRaw);
    } catch (err) {
      printError(`spend: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
  }

  let raw: unknown;
  try {
    raw = await deps.ipcCall("callTool", {
      server: METRICS_SERVER_NAME,
      tool: "get_domain_spend",
      arguments: {
        ...(domain !== undefined ? { domain } : {}),
        ...(sinceMs !== undefined ? { sinceMs } : {}),
      },
    });
  } catch (err) {
    printError(`spend: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  if (isToolError(raw)) {
    const text = extractText(raw);
    printError(`spend: ${text ?? "daemon returned an error"}`);
    process.exitCode = 1;
    return;
  }

  const text = extractText(raw);
  if (text == null) {
    printError("spend: no data returned from daemon");
    process.exitCode = 1;
    return;
  }

  const result: DomainSpendResult = JSON.parse(text);

  if (result.unknownDomain) {
    printError(`spend: unknown domain "${domain}"`);
    process.exitCode = 1;
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printHumanTable(result, domain);
}
